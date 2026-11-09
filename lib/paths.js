/**
 * Workspace resolution and root-path safety checks.
 *
 * The Host never trusts a path supplied by the browser: it resolves the
 * workspace through the DSH workspace registry and then validates the
 * canonical directory. Pure helpers are exported for unit tests.
 * @module dsh-file-integrity-check/lib/paths
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Reject a bare drive root such as `C:\` or `D:`. */
const DRIVE_ROOT_RE = /^[a-zA-Z]:[\\/]?$/

/** Wide personal folders that must never be treated as a workspace root. */
export const BROAD_HOME_DIRS = [
  'desktop',
  'documents',
  'downloads',
  'onedrive',
  'onedrive - personal',
  'onedrive - business',
  'music',
  'pictures',
  'videos',
  'dropbox',
  'google drive',
]

/** Normalize one path into a case-insensitive comparison key. */
export function pathKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const normalized = path.resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when two path strings name the same location on this platform. */
export function samePath(a, b) {
  const left = pathKey(a)
  const right = pathKey(b)
  return left !== '' && left === right
}

/** True when `child` is strictly inside `parent`. */
export function isInside(child, parent) {
  const c = pathKey(child)
  const p = pathKey(parent)
  if (c === '' || p === '') return false
  if (c === p) return false
  return c.startsWith(p + path.sep.toLowerCase())
}

/** The DSH data home; mirrors the runtime default when DSH_HOME is not exported. */
export function dshHomeDir() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/**
 * Directories that must never be repaired or scanned as a workspace root:
 * the running DSH installation (current executable directory and its
 * resources folder). A user home and the DSH data home are added by the
 * caller through validateRoot options.
 */
export function installRoots(execPath = process.execPath) {
  const appDir = path.dirname(execPath)
  const roots = new Set([appDir, path.join(appDir, 'resources')])
  // Electron layouts place the runtime under resources/app.asar; its parent
  // is still covered by the resources entry above.
  return [...roots]
}

/** Resolve realpath, returning null when the target is missing or unreadable. */
export async function realpathOrNull(target) {
  try {
    return await fs.realpath(target)
  } catch {
    return null
  }
}

/**
 * Pure safety evaluation for a canonical directory.
 *
 * @param {string} canonical absolute path (already realpath-ed)
 * @param {object} [options]
 * @param {string[]} [options.registryPaths] canonical paths of registered workspaces
 * @param {string} [options.home] user home
 * @param {string} [options.dshHome] DSH data home
 * @param {string[]} [options.installRoots] installation directories
 * @returns {{ok:true}|{ok:false, code:'path-rejected', message:string}}
 */
export function evaluateRootSafety(canonical, options = {}) {
  if (typeof canonical !== 'string' || canonical.trim() === '') {
    return reject('目标路径为空')
  }
  if (!path.isAbsolute(canonical)) {
    return reject('目标路径必须是绝对路径')
  }
  const resolved = path.normalize(canonical)
  if (DRIVE_ROOT_RE.test(resolved)) {
    return reject('磁盘根目录不能作为扫描目标')
  }

  const home = options.home ?? os.homedir()
  const dshHome = options.dshHome ?? dshHomeDir()
  const install = options.installRoots ?? installRoots()

  if (samePath(resolved, home)) {
    return reject('用户主目录不能作为扫描目标')
  }
  for (const name of BROAD_HOME_DIRS) {
    if (samePath(resolved, path.join(home, name))) {
      return reject('用户主目录下的宽泛目录（桌面/文档/下载等）不能作为扫描目标')
    }
  }
  if (samePath(resolved, dshHome) || isInside(resolved, dshHome)) {
    return reject('DSH 数据目录不能作为扫描目标')
  }
  for (const installDir of install) {
    if (samePath(resolved, installDir) || isInside(resolved, installDir)) {
      return reject('DSH 安装目录不能作为扫描目标')
    }
  }

  if (Array.isArray(options.registryPaths) && options.registryPaths.length > 0) {
    const match = options.registryPaths.some((candidate) => samePath(candidate, resolved))
    if (!match) return reject('目标路径不是任何已注册工作区的规范化路径')
  }
  return { ok: true }
}

function reject(message) {
  return { ok: false, code: 'path-rejected', message }
}

/**
 * Resolve the workspace that owns one session.
 *
 * The session id is authoritative: the registry derives each Workspace's
 * `sessionIds` from the canonical session cwd, so a live session appears in
 * exactly the workspace that owns its directory. The hint path (sent by the
 * browser) is only ever used through `resolveByPath`, never as the target.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {{ list(): object[], resolveByPath?: (p: string) => Promise<object|undefined> }} registry
 * @param {string} [input.hintPath]
 * @returns {Promise<{ok:true, workspace:{id:string,path:string,title:string}, sessionCount:number, canonicalPaths:string[]}|{ok:false,code:string,message:string}>}
 */
export async function resolveWorkspace({ sessionId, registry, hintPath }) {
  if (!registry || typeof registry.list !== 'function') {
    return { ok: false, code: 'registry-unavailable', message: 'DSH 工作区注册表不可用，无法解析当前会话的工作区' }
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, code: 'invalid-request', message: '缺少 sessionId' }
  }

  let workspaces = []
  try {
    workspaces = registry.list() ?? []
  } catch (error) {
    return { ok: false, code: 'registry-unavailable', message: '读取工作区注册表失败：' + messageOf(error) }
  }

  let workspace = workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
  let source = 'session'
  if (workspace === undefined && typeof hintPath === 'string' && hintPath.trim() !== '' && typeof registry.resolveByPath === 'function') {
    try {
      workspace = await registry.resolveByPath(hintPath)
      source = 'hint'
    } catch {
      workspace = undefined
    }
  }
  if (!workspace || typeof workspace.path !== 'string') {
    return { ok: false, code: 'workspace-not-found', message: '当前会话没有关联到已注册的 DSH 工作区' }
  }

  const canonical = await realpathOrNull(workspace.path)
  if (canonical === null) {
    return { ok: false, code: 'path-missing', message: '工作区目录不存在或无法读取：' + workspace.path }
  }

  const canonicalPaths = []
  for (const item of workspaces) {
    if (!item || typeof item.path !== 'string') continue
    const resolved = await realpathOrNull(item.path)
    if (resolved !== null) canonicalPaths.push(resolved)
  }

  const safety = evaluateRootSafety(canonical, { registryPaths: canonicalPaths })
  if (!safety.ok) return safety

  const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.slice() : []
  return {
    ok: true,
    source,
    workspace: {
      id: typeof workspace.id === 'string' ? workspace.id : '',
      path: canonical,
      title: typeof workspace.title === 'string' ? workspace.title : '',
    },
    sessionIds,
    sessionCount: sessionIds.length,
    canonicalPaths,
  }
}

/** Count live agents whose id belongs to this workspace (best effort, advisory). */
export function countLiveAgents(agents, sessionIds) {
  if (!agents || typeof agents.list !== 'function' || !Array.isArray(sessionIds)) return 0
  try {
    const ids = new Set(sessionIds)
    return agents.list().filter((agent) => agent && ids.has(agent.id)).length
  } catch {
    return 0
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
