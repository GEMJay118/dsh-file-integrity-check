/**
 * Conservative automatic cleanup of expired product artifacts.
 *
 * Only two fixed subdirectories of the effective DataDir are scanned
 * (`reports/` and `snapshots/`), never recursively, and only files whose
 * complete name matches an engine-generated artifact pattern are considered.
 * Anything else — user files, directories, symlinks/junctions, fresh files,
 * paths still referenced by an in-memory job — is skipped.
 * @module dsh-low-integrity-check/lib/cleanup
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathKey, samePath } from './paths.js'

/** Artifact subdirectories of the DataDir; never anything else. */
export const CLEANUP_DIRS = Object.freeze(['reports', 'snapshots'])

/** Default retention when the plugin config is missing or invalid. */
export const DEFAULT_RETENTION_DAYS = 30
/** Smallest user-selectable retention. */
export const MIN_RETENTION_DAYS = 1
/** Largest user-selectable retention (10 years). */
export const MAX_RETENTION_DAYS = 3650
/** Presets offered by the settings page. */
export const RETENTION_PRESETS = Object.freeze([3, 7, 15, 30])

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000
/** Fresh-artifact guard: never delete anything modified in the last 15 min (Host job TTL). */
export const RECENT_ARTIFACT_GUARD_MS = 15 * 60 * 1000
/** Bound the diagnostic skip list so one huge directory cannot grow memory. */
export const MAX_SKIPPED = 500

/** Engine-generated report name: `scan-YYYYMMDD-HHMMSS-abcdef.json`. */
const REPORT_NAME_RE = /^scan-\d{8}-\d{6}-[0-9a-f]{6}\.json$/i
/** Engine-generated snapshot name: `snapshot-YYYYMMDD-HHMMSS-abcdef.json`. */
const SNAPSHOT_NAME_RE = /^snapshot-\d{8}-\d{6}-[0-9a-f]{6}\.json$/i
/** Engine-generated restore script: `restore-YYYYMMDD-HHMMSS-abcdef.ps1`. */
const RESTORE_NAME_RE = /^restore-\d{8}-\d{6}-[0-9a-f]{6}\.ps1$/i

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * True when `name` is exactly one of the engine-generated artifact names of
 * `kind`. Matching is case-insensitive because Windows filenames are; the whole
 * name must match (no prefixes, suffixes or extra separators).
 * @param {'reports'|'snapshots'} kind
 * @param {unknown} name
 * @returns {boolean}
 */
export function isArtifactFileName(kind, name) {
  if (typeof name !== 'string' || name === '') return false
  if (kind === 'reports') return REPORT_NAME_RE.test(name)
  if (kind === 'snapshots') return SNAPSHOT_NAME_RE.test(name) || RESTORE_NAME_RE.test(name)
  return false
}

/**
 * True when `candidatePath` is a direct child of `parentDir` (so a synthetic
 * entry name such as `..\\evil` can never be treated as inside the directory).
 * @param {string} parentDir
 * @param {string} candidatePath
 * @returns {boolean}
 */
export function isDirectChild(parentDir, candidatePath) {
  if (typeof parentDir !== 'string' || typeof candidatePath !== 'string') return false
  if (parentDir.trim() === '' || candidatePath.trim() === '') return false
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  if (samePath(parent, candidate)) return false
  return samePath(path.dirname(candidate), parent)
}

/**
 * Normalize a retention value into an in-range integer day count.
 * Invalid values fall back to {@link DEFAULT_RETENTION_DAYS}.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeRetentionDays(value) {
  const candidate = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isInteger(candidate) || candidate < MIN_RETENTION_DAYS || candidate > MAX_RETENTION_DAYS) {
    return DEFAULT_RETENTION_DAYS
  }
  return candidate
}

/** Normalize protected artifact paths into a Set of comparison keys. */
function protectedKeySet(input) {
  const keys = new Set()
  const values = input instanceof Set ? [...input] : Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const key = pathKey(value)
    if (key !== '') keys.add(key)
  }
  return keys
}

function pushSkipped(list, entry) {
  if (list.length >= MAX_SKIPPED) return false
  list.push(entry)
  return true
}

/**
 * Pure selection step: decide which lstat'ed directory entries are expired
 * artifacts that may be deleted. No filesystem access happens here.
 *
 * @param {Array<{kind:string, name:string, path:string, mtimeMs:number, isFile:boolean, isSymbolicLink?:boolean, size?:number}>} entries
 * @param {object} [options]
 * @param {number} [options.now] current epoch ms
 * @param {number} [options.retentionDays] in-range integer days
 * @param {Iterable<string>|string} [options.protectedPaths] paths still referenced by in-memory jobs
 * @returns {{cutoff:number, retentionDays:number, expired:object[], skipped:Array<{path:string, reason:string}>}}
 */
export function selectExpired(entries, options = {}) {
  const now = numberOr(options.now, Date.now())
  const retentionDays = normalizeRetentionDays(options.retentionDays)
  const cutoff = now - retentionDays * DAY_MS
  const protectedKeys = protectedKeySet(options.protectedPaths)
  /** @type {object[]} */
  const expired = []
  /** @type {Array<{path:string, reason:string}>} */
  const skipped = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const entryPath = typeof entry.path === 'string' ? entry.path : ''
    const reject = (reason) => pushSkipped(skipped, { path: entryPath, reason })
    if (!isArtifactFileName(entry.kind, entry.name)) {
      reject('name-not-allowed')
      continue
    }
    if (entry.isSymbolicLink === true) {
      reject('symlink')
      continue
    }
    if (entry.isFile !== true) {
      reject('not-a-file')
      continue
    }
    const mtimeMs = typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : NaN
    if (!Number.isFinite(mtimeMs)) {
      reject('unknown-mtime')
      continue
    }
    const key = pathKey(entryPath)
    if (key !== '' && protectedKeys.has(key)) {
      reject('protected')
      continue
    }
    // Never touch anything modified during the Host job TTL window.
    if (mtimeMs > now - RECENT_ARTIFACT_GUARD_MS) {
      reject('recent')
      continue
    }
    // Strictly older than the cut-off; an exact-boundary mtime is kept.
    if (!(mtimeMs < cutoff)) {
      reject('not-expired')
      continue
    }
    expired.push({ ...entry, size: numberOr(entry.size, 0) })
  }

  return { cutoff, retentionDays, expired, skipped }
}

/**
 * Delete expired artifacts under `<dataDir>\\reports` and
 * `<dataDir>\\snapshots`. Every single failure is recorded and the run
 * continues; a missing subdirectory is normal (0-hit runs create no output).
 *
 * @param {object} options
 * @param {string} options.dataDir effective product directory
 * @param {number} [options.retentionDays] retention in days (1..3650)
 * @param {Iterable<string>|string} [options.protectedPaths] job-referenced artifact paths
 * @param {number} [options.now] clock override for tests
 * @param {(target: string) => Promise<void>} [options.unlink] unlink seam for tests
 * @param {(target: string) => Promise<object>} [options.lstat] lstat seam for tests
 * @returns {Promise<{ok:boolean, cutoff:number, deleted:Array<{path:string,bytes:number}>, freedBytes:number, skipped:Array<{path:string, reason:string}>, error:string|null}>}
 */
export async function cleanupArtifacts(options = {}) {
  const now = numberOr(options.now, Date.now())
  const retentionDays = normalizeRetentionDays(options.retentionDays)
  const cutoff = now - retentionDays * DAY_MS
  const result = { ok: true, cutoff, deleted: [], freedBytes: 0, skipped: [], error: null }
  const rawDataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
  if (rawDataDir === '') {
    result.ok = false
    result.error = '产物目录为空，跳过清理'
    return result
  }
  if (!path.isAbsolute(rawDataDir)) {
    result.ok = false
    result.error = '产物目录必须是绝对路径，跳过清理'
    return result
  }
  const base = path.resolve(rawDataDir)
  const unlink = typeof options.unlink === 'function' ? options.unlink : fs.unlink
  const lstat = typeof options.lstat === 'function' ? options.lstat : fs.lstat
  const protectedKeys = protectedKeySet(options.protectedPaths)
  const errors = []

  // Resolve the DataDir itself once. A junction/symlinked DataDir is allowed
  // (the user explicitly chose that path), so `realBase` is the resolved
  // target; the artifact subdirectories must resolve *inside* it.
  let realBase
  try {
    realBase = await fs.realpath(base)
  } catch (error) {
    // A missing DataDir means there is nothing to clean; do not create it.
    if (error?.code === 'ENOENT') return result
    result.ok = false
    result.error = '解析产物目录失败：' + messageOf(error)
    return result
  }

  for (const kind of CLEANUP_DIRS) {
    const dir = path.join(base, kind)
    let dirStat
    try {
      dirStat = await lstat(dir)
    } catch (error) {
      // A missing subdirectory is expected (no hits / already clean).
      if (error?.code !== 'ENOENT') errors.push('检查 ' + kind + ' 目录失败：' + messageOf(error))
      continue
    }
    // A symlinked/junctioned subdirectory is never followed: it could point at
    // an unrelated location outside the product directory.
    if (dirStat.isSymbolicLink()) {
      pushSkipped(result.skipped, { path: dir, reason: 'symlink' })
      continue
    }
    if (!dirStat.isDirectory()) {
      pushSkipped(result.skipped, { path: dir, reason: 'not-a-directory' })
      continue
    }

    // Windows junctions are reparse points but some Node/Windows combinations
    // report them through lstat as plain directories (`isSymbolicLink()` false,
    // `isDirectory()` true, `readlink` EINVAL). Comparing the resolved real
    // path against the expected path is the only reliable redirection check:
    // anything that resolves elsewhere (junction, symlink, mount) is skipped.
    let realDir
    try {
      realDir = await fs.realpath(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push('解析 ' + kind + ' 目录失败：' + messageOf(error))
      continue
    }
    if (!samePath(realDir, path.join(realBase, kind))) {
      pushSkipped(result.skipped, { path: dir, reason: 'symlink' })
      continue
    }

    let names
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      errors.push('读取 ' + kind + ' 目录失败：' + messageOf(error))
      continue
    }

    const entries = []
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== 'string' || name === '') continue
      const entryPath = path.join(dir, name)
      if (!isDirectChild(dir, entryPath)) {
        pushSkipped(result.skipped, { path: entryPath, reason: 'not-direct-child' })
        continue
      }
      let stat
      try {
        stat = await lstat(entryPath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        pushSkipped(result.skipped, { path: entryPath, reason: 'lstat-failed' })
        continue
      }
      entries.push({
        kind,
        name,
        path: entryPath,
        mtimeMs: stat.mtimeMs,
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: numberOr(stat.size, 0),
      })
    }

    const selection = selectExpired(entries, { now, retentionDays, protectedPaths: protectedKeys })
    for (const item of selection.skipped) pushSkipped(result.skipped, item)

    for (const candidate of selection.expired) {
      // Re-check right before deleting: the file may have been replaced by a
      // symlink, rewritten, or protected by a job that just finished.
      let fresh
      try {
        fresh = await lstat(candidate.path)
      } catch (error) {
        if (error?.code !== 'ENOENT') pushSkipped(result.skipped, { path: candidate.path, reason: 'vanished' })
        continue
      }
      if (fresh.isSymbolicLink() || !fresh.isFile()) {
        pushSkipped(result.skipped, { path: candidate.path, reason: 'changed' })
        continue
      }
      if (!(fresh.mtimeMs < cutoff) || fresh.mtimeMs > now - RECENT_ARTIFACT_GUARD_MS) {
        pushSkipped(result.skipped, { path: candidate.path, reason: 'changed' })
        continue
      }
      if (protectedKeys.has(pathKey(candidate.path))) {
        pushSkipped(result.skipped, { path: candidate.path, reason: 'protected' })
        continue
      }
      const bytes = numberOr(fresh.size, candidate.size)
      try {
        await unlink(candidate.path)
        result.deleted.push({ path: candidate.path, bytes })
        result.freedBytes += bytes
      } catch (error) {
        pushSkipped(result.skipped, { path: candidate.path, reason: 'delete-failed' })
        errors.push('删除失败：' + candidate.path + '：' + messageOf(error))
      }
    }
  }

  if (errors.length > 0) {
    result.ok = false
    result.error = errors[0] + (errors.length > 1 ? '（共 ' + String(errors.length) + ' 项错误）' : '')
  }
  return result
}
