import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cleanupArtifacts,
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  isArtifactFileName,
  isDirectChild,
  MAX_SKIPPED,
  normalizeRetentionDays,
  RECENT_ARTIFACT_GUARD_MS,
  selectExpired,
} from '../lib/cleanup.js'

const OLD_AGE_MS = 40 * DAY_MS
const SCAN_NAME = 'scan-20200101-000000-abcdef.json'
const SNAPSHOT_NAME = 'snapshot-20200101-000000-abcdef.json'
const RESTORE_NAME = 'restore-20200101-000000-abcdef.ps1'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-cleanup-'))
}

/**
 * Create one file with a deterministic mtime.
 * @returns {Promise<{path:string, bytes:number}>}
 */
async function writeAt(filePath, content, mtimeMs) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  const stamp = new Date(mtimeMs)
  await fs.utimes(filePath, stamp, stamp)
  return { path: filePath, bytes: Buffer.byteLength(content, 'utf8') }
}

async function artifact(dataDir, kind, name, mtimeMs, content = '{}') {
  return await writeAt(path.join(dataDir, kind, name), content, mtimeMs)
}

async function exists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Pure name whitelist
// ---------------------------------------------------------------------------

test('isArtifactFileName accepts only complete engine artifact names', () => {
  assert.equal(isArtifactFileName('reports', SCAN_NAME), true)
  assert.equal(isArtifactFileName('snapshots', SNAPSHOT_NAME), true)
  assert.equal(isArtifactFileName('snapshots', RESTORE_NAME), true)
  // Windows filenames are case-insensitive; matching is deliberately the same.
  assert.equal(isArtifactFileName('reports', 'SCAN-20200101-000000-ABCDEF.JSON'), true)
  assert.equal(isArtifactFileName('snapshots', 'RESTORE-20200101-000000-ABCDEF.PS1'), true)

  for (const name of [
    'scan.json',
    'scan-123.json',
    'scan-20200101-000000-zzzzzz.json',
    'scan-20200101-000000-abcde.json',
    'scan-20200101-000000-abcdefg.json',
    'scan-20200101-0000-abcdef.json',
    'scan-20200101-000000-abcdef.json.bak',
    'scan-20200101-000000-abcdef.txt',
    ' scan-20200101-000000-abcdef.json',
    'scan-20200101-000000-abcdef.json ',
    'xscan-20200101-000000-abcdef.json',
    'sub/scan-20200101-000000-abcdef.json',
    'notes.txt',
    '我的报告.json',
    '扫描报告.json',
  ]) {
    assert.equal(isArtifactFileName('reports', name), false, name)
  }
  assert.equal(isArtifactFileName('snapshots', SCAN_NAME), false)
  assert.equal(isArtifactFileName('snapshots', 'snapshot-20200101-000000-abcdef.ps1'), false)
  assert.equal(isArtifactFileName('snapshots', 'restore-20200101-000000-abcdef.json'), false)
  assert.equal(isArtifactFileName('elsewhere', SCAN_NAME), false)
  assert.equal(isArtifactFileName('reports', ''), false)
  assert.equal(isArtifactFileName('reports', null), false)
})

test('isDirectChild rejects traversal and sibling paths', async () => {
  const base = await tempDir()
  try {
    const dir = path.join(base, 'reports')
    assert.equal(isDirectChild(dir, path.join(dir, SCAN_NAME)), true)
    assert.equal(isDirectChild(dir, dir), false)
    assert.equal(isDirectChild(dir, path.resolve(dir, '..', 'evil.json')), false)
    assert.equal(isDirectChild(dir, path.join(base, 'other', SCAN_NAME)), false)
    assert.equal(isDirectChild(dir, path.resolve(dir, '..')), false)
    assert.equal(isDirectChild('', path.join(dir, SCAN_NAME)), false)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Pure selection
// ---------------------------------------------------------------------------

test('normalizeRetentionDays clamps invalid values to the default', () => {
  assert.equal(normalizeRetentionDays(3), 3)
  assert.equal(normalizeRetentionDays('7'), 7)
  assert.equal(normalizeRetentionDays(1), 1)
  assert.equal(normalizeRetentionDays(3650), 3650)
  for (const value of [0, 3651, 2.5, -1, null, undefined, 'abc', {}, []]) {
    assert.equal(normalizeRetentionDays(value), DEFAULT_RETENTION_DAYS, String(value))
  }
})

test('selectExpired computes the cutoff and keeps an exact-boundary mtime', () => {
  const now = 1_700_000_000_000
  const cutoff = now - 7 * DAY_MS
  const entries = [
    { kind: 'reports', name: SCAN_NAME, path: 'C:\\data\\reports\\' + SCAN_NAME, mtimeMs: cutoff - 1, isFile: true },
    { kind: 'reports', name: 'scan-20200101-000000-abcdea.json', path: 'C:\\data\\reports\\b', mtimeMs: cutoff, isFile: true },
    { kind: 'reports', name: 'scan-20200101-000000-abcdeb.json', path: 'C:\\data\\reports\\c', mtimeMs: cutoff + 1, isFile: true },
  ]
  const result = selectExpired(entries, { now, retentionDays: 7 })
  assert.equal(result.cutoff, cutoff)
  assert.deepEqual(result.expired.map((entry) => entry.name), [SCAN_NAME])
  const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]))
  assert.equal(reasons.get('C:\\data\\reports\\b'), 'not-expired')
  assert.equal(reasons.get('C:\\data\\reports\\c'), 'not-expired')
})

test('selectExpired keeps anything modified inside the 15 minute guard', () => {
  const now = 1_700_000_000_000
  const entries = [
    { kind: 'reports', name: SCAN_NAME, path: 'C:\\data\\reports\\a', mtimeMs: now - 60 * 1000, isFile: true },
    {
      kind: 'reports',
      name: 'scan-20200101-000000-abcdea.json',
      path: 'C:\\data\\reports\\b',
      mtimeMs: now - RECENT_ARTIFACT_GUARD_MS + 1000,
      isFile: true,
    },
  ]
  const result = selectExpired(entries, { now, retentionDays: 1 })
  assert.deepEqual(result.expired, [])
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['recent', 'recent'])
})

test('selectExpired never touches user files or malformed names', () => {
  const now = 1_700_000_000_000
  const names = ['notes.txt', '我的报告.json', '扫描报告.json', 'scan-123.json', 'scan-20200101-000000-zzzzzz.json']
  const entries = names.map((name, index) => ({
    kind: 'reports',
    name,
    path: 'C:\\data\\reports\\' + index,
    mtimeMs: now - OLD_AGE_MS,
    isFile: true,
  }))
  const result = selectExpired(entries, { now, retentionDays: 30 })
  assert.deepEqual(result.expired, [])
  assert.deepEqual(result.skipped.map((entry) => entry.reason), names.map(() => 'name-not-allowed'))
})

test('selectExpired skips directories and symlinks', () => {
  const now = 1_700_000_000_000
  const old = now - OLD_AGE_MS
  const entries = [
    { kind: 'reports', name: SCAN_NAME, path: 'C:\\data\\reports\\dir', mtimeMs: old, isFile: false },
    { kind: 'snapshots', name: SNAPSHOT_NAME, path: 'C:\\data\\snapshots\\link', mtimeMs: old, isFile: true, isSymbolicLink: true },
    { kind: 'snapshots', name: RESTORE_NAME, path: 'C:\\data\\snapshots\\link2', mtimeMs: old, isFile: false, isSymbolicLink: true },
  ]
  const result = selectExpired(entries, { now, retentionDays: 30 })
  assert.deepEqual(result.expired, [])
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['not-a-file', 'symlink', 'symlink'])
})

test('selectExpired skips paths still referenced by an in-memory job', () => {
  const now = 1_700_000_000_000
  const protectedPath = 'C:\\DATA\\Reports\\' + SCAN_NAME
  const entries = [
    { kind: 'reports', name: SCAN_NAME, path: 'C:\\data\\reports\\' + SCAN_NAME, mtimeMs: now - OLD_AGE_MS, isFile: true },
    { kind: 'reports', name: 'scan-20200101-000000-abcdea.json', path: 'c:\\data\\reports\\other.json', mtimeMs: now - OLD_AGE_MS, isFile: true },
  ]
  const result = selectExpired(entries, { now, retentionDays: 30, protectedPaths: [protectedPath] })
  assert.deepEqual(result.expired.map((entry) => entry.name), ['scan-20200101-000000-abcdea.json'])
  assert.deepEqual(result.skipped, [{ path: 'C:\\data\\reports\\' + SCAN_NAME, reason: 'protected' }])
})

test('selectExpired skips unknown mtimes and caps the diagnostic list', () => {
  const now = 1_700_000_000_000
  const unknown = selectExpired([{ kind: 'reports', name: SCAN_NAME, path: 'C:\\x', mtimeMs: NaN, isFile: true }], { now })
  assert.deepEqual(unknown.expired, [])
  assert.deepEqual(unknown.skipped.map((entry) => entry.reason), ['unknown-mtime'])

  const many = []
  for (let index = 0; index < MAX_SKIPPED + 10; index += 1) {
    many.push({ kind: 'reports', name: 'notes-' + index + '.txt', path: 'C:\\x\\' + index, mtimeMs: now, isFile: true })
  }
  const capped = selectExpired(many, { now })
  assert.equal(capped.skipped.length, MAX_SKIPPED)
})

// ---------------------------------------------------------------------------
// Filesystem cleanup
// ---------------------------------------------------------------------------

test('cleanupArtifacts deletes expired artifacts and keeps user files', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const report = await artifact(base, 'reports', SCAN_NAME, now - OLD_AGE_MS, '{"hits":1}')
    const snapshot = await artifact(base, 'snapshots', SNAPSHOT_NAME, now - OLD_AGE_MS, '{"items":[]}')
    const restore = await artifact(base, 'snapshots', RESTORE_NAME, now - OLD_AGE_MS, 'restore-script')
    const notes = await artifact(base, 'reports', 'notes.txt', now - OLD_AGE_MS, 'keep me')
    const mine = await artifact(base, 'reports', '我的报告.json', now - OLD_AGE_MS, 'keep me')

    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.equal(result.error, null)
    assert.equal(result.cutoff, now - 30 * DAY_MS)
    assert.deepEqual(
      result.deleted.map((entry) => entry.path).sort(),
      [report.path, snapshot.path, restore.path].sort(),
    )
    assert.equal(result.freedBytes, report.bytes + snapshot.bytes + restore.bytes)
    assert.equal(await exists(report.path), false)
    assert.equal(await exists(snapshot.path), false)
    assert.equal(await exists(restore.path), false)
    for (const kept of [notes, mine]) {
      assert.equal(await exists(kept.path), true, kept.path)
      assert.equal(await fs.readFile(kept.path, 'utf8'), 'keep me')
    }
    assert.ok(result.skipped.some((entry) => entry.reason === 'name-not-allowed'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts keeps fresh artifacts and files inside the retention window', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const fresh = await artifact(base, 'reports', SCAN_NAME, now - 60 * 1000)
    const within = await artifact(base, 'snapshots', SNAPSHOT_NAME, now - 10 * DAY_MS)
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
    assert.equal(await exists(fresh.path), true)
    assert.equal(await exists(within.path), true)
    const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]))
    assert.equal(reasons.get(fresh.path), 'recent')
    assert.equal(reasons.get(within.path), 'not-expired')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts does not recurse and never deletes directories', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const deep = await artifact(base, 'reports', path.join('sub', SCAN_NAME), now - OLD_AGE_MS)
    const dirNamedLikeArtifact = path.join(base, 'reports', 'scan-20200101-000000-abcdea.json')
    await fs.mkdir(dirNamedLikeArtifact, { recursive: true })
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.equal(await exists(deep.path), true)
    assert.equal(await exists(dirNamedLikeArtifact), true)
    assert.ok(result.skipped.some((entry) => entry.path === dirNamedLikeArtifact && entry.reason === 'not-a-file'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts ignores files in the DataDir root', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const rootFile = await writeAt(path.join(base, SCAN_NAME), '{}', now - OLD_AGE_MS)
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.equal(await exists(rootFile.path), true)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts tolerates missing artifact directories', async () => {
  const base = await tempDir()
  try {
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30 })
    assert.equal(result.ok, true)
    assert.equal(result.error, null)
    assert.deepEqual(result.deleted, [])
    assert.equal(result.freedBytes, 0)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts reports an empty dataDir instead of scanning anything', async () => {
  for (const dataDir of ['', '   ', null, undefined]) {
    const result = await cleanupArtifacts({ dataDir, retentionDays: 30 })
    assert.equal(result.ok, false)
    assert.match(result.error, /产物目录为空/)
    assert.deepEqual(result.deleted, [])
  }
})

test('cleanupArtifacts refuses a relative dataDir', async () => {
  const result = await cleanupArtifacts({ dataDir: 'relative-folder', retentionDays: 30 })
  assert.equal(result.ok, false)
  assert.match(result.error, /绝对路径/)
  assert.deepEqual(result.deleted, [])
})

test('cleanupArtifacts matches artifact names case-insensitively', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const upper = await artifact(base, 'reports', 'SCAN-20200101-000000-ABCDEF.JSON', now - OLD_AGE_MS)
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted.map((entry) => entry.path), [upper.path])
    assert.equal(await exists(upper.path), false)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts skips job-referenced artifacts', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const protectedFile = await artifact(base, 'reports', SCAN_NAME, now - OLD_AGE_MS)
    const deletable = await artifact(base, 'reports', 'scan-20200101-000000-abcdea.json', now - OLD_AGE_MS)
    const result = await cleanupArtifacts({
      dataDir: base,
      retentionDays: 30,
      now,
      protectedPaths: [protectedFile.path.toUpperCase()],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted.map((entry) => entry.path), [deletable.path])
    assert.equal(await exists(protectedFile.path), true)
    assert.ok(result.skipped.some((entry) => entry.path === protectedFile.path && entry.reason === 'protected'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts records a single delete failure and keeps going', async () => {
  const base = await tempDir()
  try {
    const now = Date.now()
    const first = await artifact(base, 'reports', SCAN_NAME, now - OLD_AGE_MS)
    const second = await artifact(base, 'reports', 'scan-20200101-000000-abcdea.json', now - OLD_AGE_MS)
    const result = await cleanupArtifacts({
      dataDir: base,
      retentionDays: 30,
      now,
      unlink: async (target) => {
        if (target === first.path) throw Object.assign(new Error('EACCES: deny'), { code: 'EACCES' })
        await fs.unlink(target)
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /删除失败/)
    assert.deepEqual(result.deleted.map((entry) => entry.path), [second.path])
    assert.equal(await exists(first.path), true)
    assert.equal(await exists(second.path), false)
    assert.ok(result.skipped.some((entry) => entry.path === first.path && entry.reason === 'delete-failed'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('cleanupArtifacts never follows junctioned artifact directories', async () => {
  const base = await tempDir()
  const outsideReports = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-cleanup-outside-'))
  const outsideSnapshots = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-cleanup-outside-'))
  try {
    const now = Date.now()
    const reportTarget = await writeAt(path.join(outsideReports, SCAN_NAME), '{}', now - OLD_AGE_MS)
    const snapshotTarget = await writeAt(path.join(outsideSnapshots, SNAPSHOT_NAME), '{}', now - OLD_AGE_MS)
    const restoreTarget = await writeAt(path.join(outsideSnapshots, RESTORE_NAME), 'restore', now - OLD_AGE_MS)
    // Junctions are creatable by a normal user on NTFS; a failure here is a real
    // regression for this safety case, not something to skip.
    await fs.symlink(outsideReports, path.join(base, 'reports'), 'junction')
    await fs.symlink(outsideSnapshots, path.join(base, 'snapshots'), 'junction')

    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
    for (const target of [reportTarget, snapshotTarget, restoreTarget]) {
      assert.equal(await exists(target.path), true, target.path)
    }
    const symlinkSkips = result.skipped.filter((entry) => entry.reason === 'symlink')
    assert.equal(symlinkSkips.length, 2)
    assert.ok(symlinkSkips.some((entry) => entry.path === path.join(base, 'reports')))
    assert.ok(symlinkSkips.some((entry) => entry.path === path.join(base, 'snapshots')))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
    await fs.rm(outsideReports, { recursive: true, force: true })
    await fs.rm(outsideSnapshots, { recursive: true, force: true })
  }
})

test('cleanupArtifacts rejects a redirect that lstat reports as a plain directory', async () => {
  // Regression for a real Windows/Node combination where a junction's lstat
  // reports isSymbolicLink()=false / isDirectory()=true and readlink EINVAL.
  // The realpath comparison must still keep the redirection out of the scan.
  const base = await tempDir()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-cleanup-outside-'))
  try {
    const now = Date.now()
    const target = await writeAt(path.join(outside, SCAN_NAME), '{}', now - OLD_AGE_MS)
    const reportsDir = path.join(base, 'reports')
    await fs.symlink(outside, reportsDir, 'junction')

    const result = await cleanupArtifacts({
      dataDir: base,
      retentionDays: 30,
      now,
      lstat: async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(reportsDir)) {
          const real = await fs.lstat(targetPath)
          // Simulate the misleading Stats the bug report describes.
          return {
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false,
            mtimeMs: real.mtimeMs,
            size: real.size,
          }
        }
        return await fs.lstat(targetPath)
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
    assert.deepEqual(result.skipped, [{ path: reportsDir, reason: 'symlink' }])
    assert.equal(await exists(target.path), true)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test('cleanupArtifacts still works when the DataDir itself is a junction', async (t) => {
  const linkParent = await tempDir()
  const realData = await tempDir()
  try {
    const now = Date.now()
    const expiring = await artifact(realData, 'reports', SCAN_NAME, now - OLD_AGE_MS)
    const kept = await artifact(realData, 'reports', 'notes.txt', now - OLD_AGE_MS, 'keep me')
    const dataLink = path.join(linkParent, 'data-link')
    try {
      await fs.symlink(realData, dataLink, 'junction')
    } catch (error) {
      t.skip('无法创建 DataDir junction：' + error.code)
      return
    }
    const result = await cleanupArtifacts({ dataDir: dataLink, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.equal(result.error, null)
    // Entries are reported under the DataDir path that was configured (the
    // junction link), while the real file behind it is the same artifact.
    assert.deepEqual(result.deleted.map((entry) => entry.path), [path.join(dataLink, 'reports', SCAN_NAME)])
    assert.equal(await exists(expiring.path), false)
    assert.equal(await exists(kept.path), true)
  } finally {
    await fs.rm(linkParent, { recursive: true, force: true })
    await fs.rm(realData, { recursive: true, force: true })
  }
})

test('cleanupArtifacts skips file symlinks and keeps their targets', async (t) => {
  const base = await tempDir()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-cleanup-outside-'))
  try {
    const now = Date.now()
    const target = await writeAt(path.join(outside, 'target.json'), '{}', now - OLD_AGE_MS)
    await fs.mkdir(path.join(base, 'reports'), { recursive: true })
    try {
      await fs.symlink(target.path, path.join(base, 'reports', SCAN_NAME), 'file')
    } catch (error) {
      t.skip('无法创建文件符号链接（需要开发者模式/管理员）：' + error.code)
      return
    }
    const result = await cleanupArtifacts({ dataDir: base, retentionDays: 30, now })
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted, [])
    assert.equal(await exists(target.path), true)
    assert.ok(result.skipped.some((entry) => entry.reason === 'symlink'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})
