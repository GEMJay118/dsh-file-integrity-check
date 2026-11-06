/**
 * In-memory job manager for scan / repair runs.
 *
 * One job may run per workspace at a time. Jobs expose a small snapshot for
 * polling, paginated hit items, a JSON export and a failure log. Nothing here
 * touches the filesystem beyond the plugin data directory.
 * @module dsh-low-integrity-check/lib/jobs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startEngine } from './engine.js'

/** Limits shared by the manager and the HTTP layer. */
export const LIMITS = {
  MAX_ITEMS: 50000,
  FIRST_PAGE: 200,
  MAX_PAGE: 500,
  HARD_TIMEOUT_MS: 30 * 60 * 1000,
  WATCHDOG_MS: 5 * 60 * 1000,
  TTL_MS: 15 * 60 * 1000,
  MAX_ERRORS: 500,
  MAX_FAILED: 1000,
  MAX_LOG_FAILED: 500,
}

/** Terminal job statuses. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const WRITABLE_INTEGRITY = new Set(['Medium', 'High', 'System'])

/** Case-insensitive workspace key. */
function workspaceKey(workspacePath) {
  const normalized = path.resolve(workspacePath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Local timestamp used in file names. */
export function fileStamp(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/** Sanitize one path segment so it can be used in a Windows file name. */
export function safeSegment(value, fallback = 'workspace') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  const trimmed = cleaned.slice(0, 48)
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return fallback
  return trimmed
}

/** Pick a free file path by appending -2, -3, ... when the name already exists. */
export async function uniquePath(candidate, access = fs.access) {
  let target = candidate
  const extension = path.extname(candidate)
  const base = candidate.slice(0, candidate.length - extension.length)
  for (let index = 2; index < 100; index += 1) {
    try {
      await access(target)
      target = base + '-' + index + extension
    } catch {
      return target
    }
  }
  return target
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {'scan'|'repair'} action
 * @property {'running'|'succeeded'|'failed'|'cancelled'} status
 * @property {string} workspacePath
 */

/** Create a job manager. */
export class JobManager {
  /**
   * @param {object} options
   * @param {string} options.enginePath
   * @param {string} options.dataDir
   * @param {string} [options.skipDirs]
   * @param {Function} [options.runEngine] injectable engine starter (tests)
   * @param {object} [options.logger]
   * @param {string} [options.version]
   * @param {() => number} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor(options) {
    this.enginePath = options.enginePath
    this.dataDir = options.dataDir
    this.skipDirs = options.skipDirs ?? 'node_modules,.git,.pnpm-store'
    this.runEngine = options.runEngine ?? startEngine
    this.logger = options.logger
    this.version = options.version ?? '0.1.0'
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    /** @type {Map<string, Job>} */
    this.jobs = new Map()
    /** @type {Map<string, Job>} */
    this.running = new Map()
    this.disposed = false
  }

  /** Look up one job. */
  get(jobId) {
    return this.jobs.get(jobId)
  }

  isTerminal(job) {
    return TERMINAL.has(job.status)
  }

  /**
   * Start one scan or repair job.
   * @returns {{ok:true, jobId:string}|{ok:false, code:string, message:string}}
   */
  start({ action, workspace, sessionId }) {
    if (this.disposed) return { ok: false, code: 'internal-error', message: '插件正在卸载' }
    if (action !== 'scan' && action !== 'repair') {
      return { ok: false, code: 'invalid-request', message: '未知任务类型：' + String(action) }
    }
    const key = workspaceKey(workspace.path)
    const active = this.running.get(key)
    if (active !== undefined) {
      const label = active.action === 'scan' ? '检查' : '清除'
      return { ok: false, code: 'busy', message: '该工作区已有正在运行的' + label + '任务' }
    }

    const job = {
      id: randomUUID(),
      action,
      sessionId,
      workspacePath: workspace.path,
      workspaceTitle: workspace.title ?? '',
      status: 'running',
      phase: 'starting',
      scanned: 0,
      total: null,
      hits: 0,
      explicitCount: 0,
      inheritedCount: 0,
      rootLabel: null,
      items: [],
      truncated: false,
      errors: [],
      errorCount: 0,
      fixed: 0,
      failedCount: 0,
      failed: [],
      remainingCount: 0,
      snapshotPath: null,
      restorePath: null,
      engineVersion: null,
      envState: null,
      stderr: '',
      message: null,
      messageCode: null,
      resultReceived: false,
      cancelRequested: false,
      startedAt: this.now(),
      finishedAt: null,
      handle: null,
      hardTimer: null,
      watchdogTimer: null,
      ttlTimer: null,
    }
    this.jobs.set(job.id, job)
    this.running.set(key, job)
    this.touch(job)
    job.hardTimer = this.setTimer(() => this.requestCancel(job.id, 'timeout'), LIMITS.HARD_TIMEOUT_MS)
    job.hardTimer?.unref?.()
    void this.execute(job)
    return { ok: true, jobId: job.id }
  }

  /** Run the engine for one job. */
  async execute(job) {
    const mode = job.action === 'scan' ? 'Scan' : 'Repair'
    try {
      const handle = this.runEngine({
        enginePath: this.enginePath,
        mode,
        root: job.workspacePath,
        skipDirs: this.skipDirs,
        dataDir: this.dataDir,
        onEvent: (event) => this.handleEvent(job, event),
      })
      job.handle = handle
      if (job.cancelRequested) handle.kill()
      const exit = await handle.done
      job.stderr = typeof handle.getStderr === 'function' ? handle.getStderr() : ''
      this.onExit(job, exit ?? {})
    } catch (error) {
      this.finish(job, 'failed', '引擎启动失败：' + messageOf(error))
    }
  }

  /** Apply one engine protocol event. */
  handleEvent(job, event) {
    if (!event || typeof event.type !== 'string') return
    if (this.isTerminal(job)) return
    switch (event.type) {
      case 'env': {
        job.envState = {
          user: typeof event.user === 'string' ? event.user : null,
          integrity: typeof event.integrity === 'string' ? event.integrity : null,
          powershellVersion: typeof event.powershellVersion === 'string' ? event.powershellVersion : null,
          icaclsPath: typeof event.icaclsPath === 'string' ? event.icaclsPath : null,
          canWriteLabel: event.canWriteLabel === true,
        }
        if (job.action === 'repair' && job.envState.canWriteLabel !== true) {
          job.messageCode = 'engine-sandboxed'
          job.handle?.kill()
          this.finish(job, 'failed', '宿主派生的 PowerShell 无法修改完整性标签（当前完整性：' + (job.envState.integrity ?? '未知') + '）')
        }
        break
      }
      case 'progress': {
        if (typeof event.phase === 'string') job.phase = event.phase
        job.scanned = numberOr(event.scanned, job.scanned)
        job.total = typeof event.total === 'number' ? event.total : job.total
        this.touch(job)
        break
      }
      case 'hit': {
        if (typeof event.path !== 'string') break
        job.hits += 1
        if (event.explicit === true) job.explicitCount += 1
        else job.inheritedCount += 1
        if (job.items.length < LIMITS.MAX_ITEMS) {
          let relativePath = typeof event.relativePath === 'string' ? event.relativePath : ''
          if (relativePath === '') {
            try {
              relativePath = path.relative(job.workspacePath, event.path)
            } catch {
              relativePath = ''
            }
          }
          job.items.push({
            path: event.path,
            relativePath,
            kind: event.kind === 'dir' ? 'dir' : 'file',
            explicit: event.explicit === true,
            label: 'Low',
          })
        } else {
          job.truncated = true
        }
        this.touch(job)
        break
      }
      case 'error': {
        job.errorCount += 1
        if (job.errors.length < LIMITS.MAX_ERRORS) {
          job.errors.push({
            path: typeof event.path === 'string' ? event.path : '',
            message: typeof event.message === 'string' ? event.message : '未知错误',
          })
        } else {
          job.truncated = true
        }
        if (event.phase === 'repair' && typeof event.path === 'string') {
          job.failedCount += 1
          if (job.failed.length < LIMITS.MAX_FAILED) {
            job.failed.push({
              path: event.path,
              message: typeof event.message === 'string' ? event.message : '未知错误',
              output: typeof event.output === 'string' ? event.output.slice(0, 4000) : '',
            })
          }
        }
        this.touch(job)
        break
      }
      case 'result': {
        job.resultReceived = true
        if (typeof event.engineVersion === 'string') job.engineVersion = event.engineVersion
        if (typeof event.rootLabel === 'string') job.rootLabel = event.rootLabel
        if (typeof event.scanned === 'number') job.scanned = event.scanned
        if (typeof event.hits === 'number') job.hits = Math.max(job.hits, event.hits)
        if (typeof event.explicitCount === 'number') job.explicitCount = event.explicitCount
        if (typeof event.inheritedCount === 'number') job.inheritedCount = event.inheritedCount
        if (event.truncated === true) job.truncated = true
        if (typeof event.fixed === 'number') job.fixed = event.fixed
        if (typeof event.snapshotPath === 'string' && event.snapshotPath !== '') job.snapshotPath = event.snapshotPath
        if (typeof event.restorePath === 'string' && event.restorePath !== '') job.restorePath = event.restorePath
        if (typeof event.remaining === 'number') job.remainingCount = event.remaining
        else if (Array.isArray(event.remaining)) job.remainingCount = event.remaining.length
        if (Array.isArray(event.failed)) {
          // Final failed list from the engine is authoritative: drop failures
          // that streamed in as progress events and rebuild once.
          job.failedCount = 0
          job.failed = []
          for (const entry of event.failed) {
            if (!entry || typeof entry.path !== 'string') continue
            job.failedCount += 1
            if (job.failed.length < LIMITS.MAX_FAILED) {
              job.failed.push({
                path: entry.path,
                message: typeof entry.message === 'string' ? entry.message : '未知错误',
                output: typeof entry.output === 'string' ? entry.output.slice(0, 4000) : '',
              })
            }
          }
        }
        this.touch(job)
        break
      }
      case 'fatal': {
        job.message = typeof event.message === 'string' ? event.message : '引擎异常退出'
        break
      }
      default:
        break
    }
  }

  /** Settle a job after the engine process exits. */
  onExit(job, exit) {
    if (this.isTerminal(job)) return
    if (job.messageCode === 'engine-sandboxed') {
      this.finish(job, 'failed', job.message)
      return
    }
    if (job.cancelRequested) {
      this.finish(job, 'cancelled', job.message ?? '已取消')
      return
    }
    if (typeof exit.error === 'string' && exit.error !== '') {
      this.finish(job, 'failed', '无法启动引擎：' + exit.error)
      return
    }
    if (job.resultReceived !== true) {
      const detail = typeof job.stderr === 'string' && job.stderr.trim() !== '' ? '：' + lastLine(job.stderr) : ''
      this.finish(job, 'failed', '引擎异常退出（退出码 ' + String(exit.code) + '）' + detail)
      return
    }
    if (job.action === 'scan') {
      this.finish(job, 'succeeded', null)
      return
    }
    if (job.failedCount > 0) {
      this.finish(job, 'failed', '清除失败（' + job.failedCount + ' 项）')
      return
    }
    this.finish(job, 'succeeded', null)
  }

  /** Move one job into a terminal state. */
  finish(job, status, message = null) {
    if (this.isTerminal(job)) return
    job.status = status
    if (message !== null) job.message = message
    job.finishedAt = this.now()
    this.clearJobTimers(job)
    this.running.delete(workspaceKey(job.workspacePath))
    if (this.disposed) {
      this.jobs.delete(job.id)
      return
    }
    job.ttlTimer = this.setTimer(() => {
      this.jobs.delete(job.id)
    }, LIMITS.TTL_MS)
    job.ttlTimer?.unref?.()
  }

  /** Reset the no-progress watchdog after observed engine activity. */
  touch(job) {
    if (job.watchdogTimer !== null) this.clearTimer(job.watchdogTimer)
    job.watchdogTimer = this.setTimer(() => this.requestCancel(job.id, 'timeout'), LIMITS.WATCHDOG_MS)
    job.watchdogTimer?.unref?.()
  }

  clearJobTimers(job) {
    for (const timer of [job.hardTimer, job.watchdogTimer]) {
      if (timer !== null && timer !== undefined) this.clearTimer(timer)
    }
    job.hardTimer = null
    job.watchdogTimer = null
  }

  /** Request cancellation of one job (user action or timeout). */
  requestCancel(jobId, reason = 'user') {
    const job = this.jobs.get(jobId)
    if (job === undefined) return { ok: false, code: 'job-not-found', message: '任务不存在或已过期' }
    if (this.isTerminal(job)) return { ok: true, alreadyFinished: true }
    job.cancelRequested = true
    job.message = reason === 'timeout' ? '任务超时或被判定为无进度，已取消' : '已取消'
    try {
      job.handle?.kill()
    } catch {
      /* already gone */
    }
    if (job.handle === null || job.handle === undefined) this.finish(job, 'cancelled', job.message)
    return { ok: true }
  }

  /** Compact snapshot used by the polling endpoint. */
  snapshot(job) {
    return {
      id: job.id,
      action: job.action,
      status: job.status,
      phase: job.phase,
      scanned: job.scanned,
      total: job.total,
      hits: job.hits,
      explicitCount: job.explicitCount,
      inheritedCount: job.inheritedCount,
      rootLabel: job.rootLabel,
      fixed: job.fixed,
      failedCount: job.failedCount,
      failed: job.failed.slice(0, 100),
      remainingCount: job.remainingCount,
      errors: job.errors.slice(0, 50),
      errorCount: job.errorCount,
      items: job.items.slice(0, LIMITS.FIRST_PAGE),
      truncated: job.truncated || job.items.length > LIMITS.FIRST_PAGE,
      snapshotPath: job.snapshotPath,
      restorePath: job.restorePath,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      message: job.message,
      messageCode: job.messageCode,
      env: job.envState,
    }
  }

  /** One page of hit items. */
  itemsPage(job, offsetInput, limitInput) {
    const offset = Math.max(0, Math.floor(numberOr(offsetInput, 0)))
    const limit = Math.min(LIMITS.MAX_PAGE, Math.max(1, Math.floor(numberOr(limitInput, LIMITS.FIRST_PAGE))))
    return {
      jobId: job.id,
      offset,
      limit,
      total: job.items.length,
      items: job.items.slice(offset, offset + limit),
    }
  }

  /** Write the full hit list as a JSON export and return its path. */
  async exportScan(job) {
    if (job.action !== 'scan') return { ok: false, code: 'invalid-request', message: '只有检查任务可以导出清单' }
    if (!this.isTerminal(job) && job.items.length === 0) {
      return { ok: false, code: 'invalid-request', message: '任务尚未产生结果' }
    }
    const dir = path.join(this.dataDir, 'exports')
    await fs.mkdir(dir, { recursive: true })
    const stamp = fileStamp(this.now())
    const base = safeSegment(job.workspaceTitle || path.basename(job.workspacePath))
    const target = await uniquePath(path.join(dir, 'low-integrity-' + base + '-' + stamp + '.json'))
    const payload = {
      plugin: 'dsh-low-integrity-check',
      version: this.version,
      exportedAt: new Date(this.now()).toISOString(),
      workspacePath: job.workspacePath,
      workspaceTitle: job.workspaceTitle,
      rootLabel: job.rootLabel,
      engineVersion: job.engineVersion,
      scannedAt: new Date(job.startedAt).toISOString(),
      scanned: job.scanned,
      hits: job.hits,
      explicitCount: job.explicitCount,
      inheritedCount: job.inheritedCount,
      truncated: job.truncated,
      items: job.items,
    }
    await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: target }
  }

  /** Write a failure log and return its path. */
  async writeLog(job) {
    const dir = path.join(this.dataDir, 'logs')
    await fs.mkdir(dir, { recursive: true })
    const stamp = fileStamp(this.now())
    const target = await uniquePath(path.join(dir, job.action + '-' + stamp + '.log'))
    const lines = []
    lines.push('dsh-low-integrity-check failure log')
    lines.push('time: ' + new Date(this.now()).toISOString())
    lines.push('plugin version: ' + this.version)
    lines.push('action: ' + job.action)
    lines.push('status: ' + job.status)
    if (job.message) lines.push('message: ' + job.message)
    lines.push('workspace: ' + job.workspacePath)
    lines.push('startedAt: ' + new Date(job.startedAt).toISOString())
    if (job.finishedAt !== null) lines.push('finishedAt: ' + new Date(job.finishedAt).toISOString())
    lines.push('')
    lines.push('--- engine environment preflight ---')
    lines.push(job.envState ? JSON.stringify(job.envState, null, 2) : 'unavailable')
    lines.push('')
    lines.push('--- summary ---')
    lines.push(
      JSON.stringify(
        {
          scanned: job.scanned,
          hits: job.hits,
          explicitCount: job.explicitCount,
          inheritedCount: job.inheritedCount,
          rootLabel: job.rootLabel,
          fixed: job.fixed,
          failedCount: job.failedCount,
          errorCount: job.errorCount,
          snapshotPath: job.snapshotPath,
          restorePath: job.restorePath,
        },
        null,
        2,
      ),
    )
    lines.push('')
    lines.push('--- engine stderr ---')
    lines.push(job.stderr?.trim() || '(empty)')
    lines.push('')
    lines.push('--- unreadable entries (first ' + Math.min(job.errors.length, 200) + ') ---')
    for (const entry of job.errors.slice(0, 200)) lines.push(entry.path + ' :: ' + entry.message)
    lines.push('')
    lines.push('--- failed objects (first ' + Math.min(job.failed.length, LIMITS.MAX_LOG_FAILED) + ') ---')
    for (const entry of job.failed.slice(0, LIMITS.MAX_LOG_FAILED)) {
      lines.push('path: ' + entry.path)
      lines.push('error: ' + entry.message)
      if (entry.output) lines.push('icacls output: ' + entry.output.replace(/\r?\n/g, ' | '))
      lines.push('')
    }
    lines.push('--- guidance ---')
    lines.push('Some objects were rejected by Windows access control. Re-run the same repair in an elevated (administrator) PowerShell if the rejects persist.')
    await fs.writeFile(target, lines.join('\n'), 'utf8')
    return { ok: true, path: target }
  }

  /** Kill every running job and drop all state (plugin unload). */
  dispose() {
    this.disposed = true
    for (const job of this.jobs.values()) {
      this.clearJobTimers(job)
      if (job.ttlTimer !== null) this.clearTimer(job.ttlTimer)
      try {
        job.handle?.kill()
      } catch {
        /* best effort */
      }
    }
    this.jobs.clear()
    this.running.clear()
  }
}

function lastLine(text) {
  const lines = text.trim().split(/\r?\n/)
  return lines[lines.length - 1] ?? ''
}
