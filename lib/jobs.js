/**
 * In-memory job manager for scan / repair runs.
 *
 * One job may run per workspace at a time. Jobs expose a small snapshot for
 * polling, paginated hit items and the engine-written report path. The manager
 * never touches the filesystem itself.
 * @module dsh-file-integrity-check/lib/jobs
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startEngine } from './engine.js'
import { isInside } from './datadir.js'
import { pathKey, samePath } from './paths.js'

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
}

/** Terminal job statuses. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const WRITABLE_INTEGRITY = new Set(['Medium', 'High', 'System'])

/** Case-insensitive workspace key. */
function workspaceKey(workspacePath) {
  const normalized = path.resolve(workspacePath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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
 * @property {string} dataDir product directory pinned when the job started
 */

/** Create a job manager. */
export class JobManager {
  /**
   * @param {object} options
   * @param {string} options.enginePath
   * @param {() => object|string} [options.getDataDir] live product-directory reader
   * @param {string} [options.dataDir] static fallback when no reader is given (tests)
   * @param {string} [options.skipDirs]
   * @param {Function} [options.runEngine] injectable engine starter (tests)
   * @param {(job: Job) => void} [options.onFinished] called once when a job reaches a terminal state
   * @param {object} [options.logger]
   * @param {string} [options.version]
   * @param {() => number} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor(options) {
    this.enginePath = options.enginePath
    this.getDataDir = typeof options.getDataDir === 'function' ? options.getDataDir : null
    this.dataDir = options.dataDir
    this.skipDirs = options.skipDirs ?? 'node_modules,.git,.pnpm-store'
    this.runEngine = options.runEngine ?? startEngine
    this.onFinished = typeof options.onFinished === 'function' ? options.onFinished : null
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

  /**
   * Read the product directory for a job that is about to start. The live
   * reader re-reads the volatile plugin config every time; any failure falls
   * back to the static default rather than failing the job.
   * @returns {string}
   */
  resolveDataDir() {
    if (this.getDataDir !== null) {
      try {
        const value = this.getDataDir()
        if (typeof value === 'string' && value.trim() !== '') return value
        if (value !== null && typeof value === 'object' && typeof value.dataDir === 'string' && value.dataDir.trim() !== '') {
          return value.dataDir
        }
      } catch {
        /* fall through to the static fallback */
      }
    }
    return typeof this.dataDir === 'string' ? this.dataDir : ''
  }


  /**
   * Artifact paths still referenced by in-memory jobs (report / snapshot /
   * restore). Automatic cleanup must never delete these even when they are
   * older than the retention window. Returns normalized comparison keys.
   * @returns {Set<string>}
   */
  protectedArtifactPaths() {
    const keys = new Set()
    for (const job of this.jobs.values()) {
      for (const value of [job.reportPath, job.snapshotPath, job.restorePath]) {
        if (typeof value !== 'string' || value.trim() === '') continue
        const key = pathKey(value)
        if (key !== '') keys.add(key)
      }
    }
    return keys
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
  start({ action, workspace, sessionId, depth }) {
    if (this.disposed) return { ok: false, code: 'internal-error', message: '插件正在卸载' }
    if (action !== 'scan' && action !== 'repair') {
      return { ok: false, code: 'invalid-request', message: '未知任务类型：' + String(action) }
    }
    const scanDepth = action === 'scan' ? (depth === 'deep' ? 'deep' : 'quick') : null
    // The product directory is fixed for the whole job (open-folder validates
    // against this value), and it must never sit inside the scanned workspace:
    // snapshots/reports must not enter the scan surface (C12).
    const dataDir = this.resolveDataDir()
    if (typeof dataDir === 'string' && dataDir !== '' && (samePath(workspace.path, dataDir) || isInside(workspace.path, dataDir))) {
      return {
        ok: false,
        code: 'data-dir-inside-workspace',
        message: '产物目录位于当前工作区内（' + dataDir + '），快照与报告会进入扫描面；请先在插件设置里改用工作区外的目录',
      }
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
      depth: scanDepth,
      itemsScope: action === 'scan' ? (scanDepth === 'quick' ? 'explicit' : 'all') : null,
      workspacePath: workspace.path,
      workspaceTitle: workspace.title ?? '',
      dataDir,
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
        dataDir: job.dataDir,
        scanDepth: job.action === 'scan' ? job.depth : undefined,
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
        // Repair no longer streams `hit` events: its progress events carry the
        // absolute counters `hits` (Low objects discovered) and `fixed`
        // (cumulative repaired), while `total` is only numeric after the
        // enumerate phase. Cumulative counters never move backwards, so merge
        // with Math.max; the final `result` event stays authoritative.
        // Repair reports `total` for the repair phase (= hit count) and for the
        // final verify phase (= failed candidates). The latter is much smaller and
        // must not replace the hit-count total used by the panel progress bar/ETA.
        if (typeof event.total === 'number' && event.phase !== 'verify') job.total = event.total
        if (typeof event.hits === 'number') job.hits = Math.max(job.hits, event.hits)
        if (typeof event.fixed === 'number') job.fixed = Math.max(job.fixed, event.fixed)
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
        if (typeof event.engine === 'string') job.engine = event.engine
        if (typeof event.depth === 'string') job.depth = event.depth
        if (typeof event.itemsScope === 'string') job.itemsScope = event.itemsScope
        if (typeof event.reportPath === 'string' && event.reportPath !== '') job.reportPath = event.reportPath
        if (typeof event.rootLabel === 'string') job.rootLabel = event.rootLabel
        if (typeof event.scanned === 'number') job.scanned = event.scanned
        // Result counts are authoritative. Quick scans stream their explicit
        // `hit` events only after progress already reported the full Low count,
        // so a plain Math.max() would keep that transient over-count forever.
        if (typeof event.hits === 'number') job.hits = event.hits
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
        // The engine caps result.failed at 1000 entries; failedTotal is the
        // authoritative failure count (e.g. an "everything failed" repair).
        if (typeof event.failedTotal === 'number') job.failedCount = event.failedTotal
        // result.errors is authoritative for scan/read problems. Repair no longer
        // streams scan-time error events, so without this the panel and the failure
        // log would silently miss unreadable objects (Repair-specific gap).
        if (Array.isArray(event.errors)) {
          const seen = new Set(job.errors.map((entry) => entry.path + '\u0000' + entry.message))
          for (const entry of event.errors) {
            if (!entry || typeof entry.path !== 'string') continue
            const message = typeof entry.message === 'string' ? entry.message : '未知错误'
            const key = entry.path + '\u0000' + message
            if (seen.has(key)) continue
            seen.add(key)
            job.errorCount += 1
            if (job.errors.length < LIMITS.MAX_ERRORS) {
              job.errors.push({ path: entry.path, message })
            } else {
              job.truncated = true
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
    // Notify after the terminal state is fully settled; a throw here must never
    // change the job result or the caller's response.
    if (this.onFinished !== null) {
      try {
        this.onFinished(job)
      } catch (error) {
        try {
          this.logger?.warn?.('[dsh-file-integrity-check] onFinished failed: ' + messageOf(error))
        } catch {
          /* logging must never break job settlement */
        }
      }
    }
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
      depth: job.depth,
      itemsScope: job.itemsScope,
      engine: job.engine,
      dataDir: job.dataDir,
      reportPath: job.reportPath,
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

  /** Hand off the engine-written report path for a finished scan. */
  async exportScan(job) {
    if (job.action !== 'scan') return { ok: false, code: 'invalid-request', message: '只有检查任务可以导出清单' }
    // The engine writes the authoritative report file, so exporting is just a
    // path hand-off: large scans never travel through the Host again.
    if (typeof job.reportPath === 'string' && job.reportPath !== '') {
      return { ok: true, path: job.reportPath, fromEngine: true }
    }
    return { ok: false, code: 'no-report', message: '本次扫描没有可导出的报告（未生成或写入失败）' }
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
