/**
 * Product directory (DataDir) resolution and safety validation.
 *
 * The DataDir receives the engine-written reports and snapshots, so it is a
 * Host-owned write surface. The browser may only send a *candidate* path; every
 * rule below is enforced here, on the Host, before anything is created or
 * written. Pure helpers are exported for unit tests.
 * @module dsh-file-integrity-check/lib/datadir
 */
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshHomeDir, installRoots, pathKey, samePath } from './paths.js'

/** A Windows drive-letter absolute path (`D:\` or `D:/`). */
const DRIVE_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/

/** A bare drive root such as `D:\`, `D:/` or `D:`. */
const DRIVE_ROOT_RE = /^[a-zA-Z]:[\\/]*$/

/** UNC / device paths (`\\server\share`, `\\?\D:\...`, `//server/share`). */
const UNC_RE = /^[\\/]{2}/

/** Characters a Windows path component may not carry. */
const ILLEGAL_PATH_CHARS_RE = /[<>"|?*\u0000-\u001f]/

/** Prefix of the throwaway probe file written by {@link ensureWritable}. */
const PROBE_PREFIX = '.dsh-integrity-check-probe-'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function rejected(message) {
  return { ok: false, code: 'settings-invalid', message }
}

/**
 * The default product directory: `%DSH_HOME%\low-integrity-check`.
 * @returns {string}
 */
export function defaultDataDir() {
  return path.join(dshHomeDir(), 'low-integrity-check')
}

/**
 * True when `child` is strictly inside `parent` (case-insensitive on Windows).
 * Both arguments are resolved first; equal paths are not "inside".
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const parentKey = pathKey(parent)
  const childKey = pathKey(child)
  if (parentKey === '' || childKey === '') return false
  if (parentKey === childKey) return false
  const separator = process.platform === 'win32' ? '\\' : '/'
  return childKey.startsWith(parentKey + separator)
}

/**
 * Validate one user-supplied product directory.
 *
 * An empty string means "use the default directory" and is accepted (the
 * caller persists an empty string). Every other value must be a drive-letter
 * absolute path that is not a drive root, the user home, a DSH data/sessions/
 * profiles root, or the running DSH installation; an existing target must be
 * a directory. Nothing is created here: writing is {@link ensureWritable}.
 *
 * @param {unknown} input candidate path
 * @param {object} [options] injectable environment (tests)
 * @param {string} [options.home] user home
 * @param {string} [options.dshHome] DSH data home
 * @param {string[]} [options.installRoots] DSH installation directories
 * @returns {{ok:true, path:string, isDefault:boolean}|{ok:false, code:'settings-invalid', message:string}}
 */
export function validateDataDir(input, options = {}) {
  if (typeof input !== 'string') return rejected('产物目录必须是字符串')
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, path: '', isDefault: true }
  if (UNC_RE.test(trimmed)) return rejected('不支持 UNC 网络路径或设备路径，请使用带盘符的本地目录')

  const home = typeof options.home === 'string' && options.home !== '' ? options.home : os.homedir()
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : dshHomeDir()
  const install = Array.isArray(options.installRoots) ? options.installRoots : installRoots()

  // Check the *input*: a relative or drive-relative path (`data`, `D:data`)
  // would otherwise be silently resolved against the Host working directory.
  if (!path.isAbsolute(trimmed) || !DRIVE_ABSOLUTE_RE.test(trimmed)) {
    return rejected('产物目录必须是带盘符的绝对路径（例如 D:\\integrity-data）')
  }
  const resolved = path.resolve(trimmed)
  if (DRIVE_ROOT_RE.test(resolved)) return rejected('磁盘根目录不能作为产物目录')
  // Reject characters Windows cannot store, and alternate data streams
  // (`D:\data:stream`): only the drive colon may appear.
  const rest = resolved.slice(2)
  if (ILLEGAL_PATH_CHARS_RE.test(rest) || rest.includes(':')) {
    return rejected('产物目录包含 Windows 不允许的字符')
  }

  if (samePath(resolved, home)) return rejected('用户主目录本身不能作为产物目录')
  if (samePath(resolved, dshHome)) return rejected('DSH 数据目录根目录不能作为产物目录')
  for (const protectedName of ['sessions', 'profiles']) {
    const protectedDir = path.join(dshHome, protectedName)
    if (samePath(resolved, protectedDir) || isInside(protectedDir, resolved)) {
      return rejected('不能把产物目录放进 DSH 的 ' + protectedName + ' 目录')
    }
  }
  for (const installDir of install) {
    if (typeof installDir !== 'string' || installDir === '') continue
    if (samePath(resolved, installDir) || isInside(installDir, resolved)) {
      return rejected('不能把产物目录放进 DSH 安装目录')
    }
  }

  let stat = null
  try {
    stat = statSync(resolved)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return rejected('无法检查产物目录：' + messageOf(error))
    }
  }
  if (stat !== null && !stat.isDirectory()) return rejected('产物目录已存在且不是文件夹')

  return { ok: true, path: resolved, isDefault: false }
}

/**
 * Create the directory (recursively) and prove it is writable by writing and
 * deleting a throwaway probe file. This is the only place the Host creates the
 * user-chosen path, and it runs only after {@link validateDataDir} succeeded.
 *
 * @param {string} dirPath
 * @returns {Promise<{ok:true, path:string}|{ok:false, code:'settings-unwritable', message:string}>}
 */
export async function ensureWritable(dirPath) {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') {
    return { ok: false, code: 'settings-unwritable', message: '产物目录为空' }
  }
  const resolved = path.resolve(dirPath)
  const probe = path.join(resolved, PROBE_PREFIX + String(process.pid) + '-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8))
  try {
    await fs.mkdir(resolved, { recursive: true })
    await fs.writeFile(probe, 'probe', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    return { ok: false, code: 'settings-unwritable', message: '产物目录不可写：' + messageOf(error) }
  }
  try {
    await fs.unlink(probe)
  } catch {
    /* the probe file is already gone or cannot be removed; the directory is writable */
  }
  return { ok: true, path: resolved }
}
