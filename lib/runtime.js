/**
 * Wire the Host plugin into one Cordis context: probe, jobs, HTTP route.
 * @module dsh-file-integrity-check/lib/runtime
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startEngine } from './engine.js'
import { JobManager } from './jobs.js'
import { createHttpHandler, PREFIX } from './routes.js'
import { defaultDataDir, ensureWritable, validateDataDir } from './datadir.js'
import { cleanupArtifacts, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from './cleanup.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_PATH = path.join(PKG_ROOT, 'engine', 'integrity.ps1')
const ENGINE_PROBE_TTL_MS = 60 * 1000
const ENGINE_PROBE_TIMEOUT_MS = 20 * 1000
/** First automatic cleanup after activation. */
const CLEANUP_START_DELAY_MS = 10 * 1000
/** Periodic automatic cleanup interval. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Read the package version without depending on JSON import attributes. */
function packageVersion() {
  try {
    const raw = readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Open one folder with the OS file manager (Windows Explorer). */
function openFolderInExplorer(folderPath) {
  return new Promise((resolve, reject) => {
    const systemRoot = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== '' ? process.env.SystemRoot : 'C:\\Windows'
    const explorerPath = path.join(systemRoot, 'explorer.exe')
    let child
    try {
      // Do NOT pass windowsHide here: it sets STARTF_USESHOWWINDOW/SW_HIDE and the
      // Explorer window it creates inherits that, so the folder opens invisibly.
      child = spawn(explorerPath, [folderPath], { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', (error) => reject(error))
    child.once('spawn', () => {
      try {
        child.unref()
      } catch {
        /* already gone */
      }
      resolve()
    })
  })
}

/** Soft-get one optional DSH service without throwing on a strict ctx. */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* service absent or not injectable */
  }
  return undefined
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the runtime for one plugin activation.
 * @param {object} ctx Cordis context with webServer injected
 * @param {object} [config] resolved plugin config (volatile fields are refs)
 */
export function createRuntime(ctx, config = {}) {
  const version = packageVersion()

  /**
   * Read the raw configured DataDir. A schema `volatile()` field reaches the
   * plugin as a live ref (`.get()`); a plain string is accepted as-is so the
   * plugin still works when the Config schema could not be resolved (C3/C6).
   */
  function readConfiguredDataDir() {
    try {
      const field = config === null || typeof config !== 'object' ? undefined : config.dataDir
      if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
        const value = field.get()
        return { raw: value === undefined || value === null ? '' : String(value), error: null }
      }
      if (field === undefined || field === null) return { raw: '', error: null }
      if (typeof field === 'string') return { raw: field, error: null }
      return { raw: '', error: '配置字段 dataDir 类型无效' }
    } catch (error) {
      return { raw: '', error: '读取产物目录配置失败：' + messageOf(error) }
    }
  }

  /**
   * Resolve the effective product directory for this moment. Re-read on every
   * call so a volatile config update takes effect without reloading the plugin;
   * an invalid value falls back to the default directory and reports `error`.
   */
  function dataDirState() {
    const fallback = defaultDataDir()
    try {
      const read = readConfiguredDataDir()
      if (read.error !== null) {
        return { dataDir: fallback, defaultDataDir: fallback, isDefault: true, error: read.error + '；已回退默认目录' }
      }
      const validation = validateDataDir(read.raw)
      if (!validation.ok) {
        return {
          dataDir: fallback,
          defaultDataDir: fallback,
          isDefault: true,
          error: '产物目录配置无效：' + validation.message + '；已回退默认目录',
        }
      }
      if (validation.isDefault) return { dataDir: fallback, defaultDataDir: fallback, isDefault: true, error: null }
      return { dataDir: validation.path, defaultDataDir: fallback, isDefault: false, error: null }
    } catch (error) {
      return {
        dataDir: fallback,
        defaultDataDir: fallback,
        isDefault: true,
        error: '解析产物目录失败：' + messageOf(error) + '；已回退默认目录',
      }
    }
  }

  /**
   * Read the raw configured retention in days. Accepts a volatile ref
   * (`.get()`) or a plain number/string; anything outside 1..3650 is invalid.
   */
  function readConfiguredRetention() {
    try {
      const field = config === null || typeof config !== 'object' ? undefined : config.retentionDays
      let raw = field
      if (field !== null && typeof field === 'object' && typeof field.get === 'function') raw = field.get()
      if (raw === undefined || raw === null) return { value: DEFAULT_RETENTION_DAYS, error: null }
      const candidate = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
      if (!Number.isInteger(candidate) || candidate < MIN_RETENTION_DAYS || candidate > MAX_RETENTION_DAYS) {
        return {
          value: DEFAULT_RETENTION_DAYS,
          error:
            '保留天数配置无效（需要 ' +
            String(MIN_RETENTION_DAYS) +
            '..' +
            String(MAX_RETENTION_DAYS) +
            ' 的整数），已回退默认 ' +
            String(DEFAULT_RETENTION_DAYS) +
            ' 天',
        }
      }
      return { value: candidate, error: null }
    } catch (error) {
      return { value: DEFAULT_RETENTION_DAYS, error: '读取保留天数配置失败：' + messageOf(error) }
    }
  }

  /** Effective retention used by cleanup and the settings page. */
  function retentionState() {
    const read = readConfiguredRetention()
    return { retentionDays: read.value, defaultRetentionDays: DEFAULT_RETENTION_DAYS, error: read.error }
  }

  /** Last automatic-cleanup result (lastCleanup contract) or null before the first run. */
  let lastCleanup = null
  let cleanupRunning = false

  /**
   * Run one conservative cleanup pass. Never throws; overlapping triggers are
   * coalesced by a running flag. Returns the latest lastCleanup snapshot.
   * @param {string} reason startup | job | interval | settings | manual
   */
  async function runCleanup(reason = 'manual') {
    if (cleanupRunning) return lastCleanup
    cleanupRunning = true
    try {
      const dataDir = dataDirState()
      const retention = retentionState()
      const protectedPaths = jobs.protectedArtifactPaths()
      const result = await cleanupArtifacts({
        dataDir: dataDir.dataDir,
        retentionDays: retention.retentionDays,
        protectedPaths,
      })
      lastCleanup = {
        at: Date.now(),
        cutoff: result.cutoff,
        deletedCount: result.deleted.length,
        freedBytes: result.freedBytes,
        error: result.error,
      }
      if (result.error !== null) {
        try {
          ctx.logger?.warn?.('[dsh-file-integrity-check] cleanup (' + reason + '): ' + result.error)
        } catch {
          /* logging must never break cleanup */
        }
      }
      return lastCleanup
    } catch (error) {
      lastCleanup = { at: Date.now(), cutoff: null, deletedCount: 0, freedBytes: 0, error: messageOf(error) }
      return lastCleanup
    } finally {
      cleanupRunning = false
    }
  }

  /**
   * Validate and persist a settings patch through the optional `configEditor`
   * service. `dataDir` and/or `retentionDays` may be supplied; both are merged
   * into one config write. An empty `dataDir` persists the default marker.
   * @param {{dataDir?: unknown, retentionDays?: unknown}} input
   */
  async function saveSettings(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'settings-invalid', message: '设置必须是对象' }
    }
    const hasDataDir = Object.prototype.hasOwnProperty.call(input, 'dataDir')
    const hasRetention = Object.prototype.hasOwnProperty.call(input, 'retentionDays')
    if (!hasDataDir && !hasRetention) {
      return { ok: false, code: 'settings-invalid', message: '至少需要提供 dataDir 或 retentionDays' }
    }

    let dataDirUpdate = null
    if (hasDataDir) {
      if (typeof input.dataDir !== 'string') return { ok: false, code: 'settings-invalid', message: 'dataDir 必须是字符串' }
      const trimmed = input.dataDir.trim()
      const validation = validateDataDir(trimmed)
      if (!validation.ok) return { ok: false, code: 'settings-invalid', message: validation.message }
      if (!validation.isDefault) {
        const writable = await ensureWritable(validation.path)
        if (!writable.ok) return writable
      }
      dataDirUpdate = {
        value: trimmed,
        path: validation.isDefault ? null : validation.path,
        isDefault: validation.isDefault === true,
      }
    }

    let retentionUpdate = null
    if (hasRetention) {
      const value = input.retentionDays
      if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
        return {
          ok: false,
          code: 'settings-invalid',
          message: '保留天数必须是 ' + String(MIN_RETENTION_DAYS) + '..' + String(MAX_RETENTION_DAYS) + ' 的整数',
        }
      }
      retentionUpdate = value
    }

    const editor = optionalService(ctx, 'configEditor')
    if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
      return { ok: false, code: 'settings-unavailable', message: 'DSH 未提供配置编辑服务（configEditor），当前无法保存设置' }
    }
    const entry = ctx.fiber?.entry
    if (entry === undefined || entry === null) {
      return { ok: false, code: 'settings-unavailable', message: '无法定位本插件的配置项，当前无法保存设置' }
    }
    const patch = {}
    if (dataDirUpdate !== null) patch.dataDir = dataDirUpdate.value
    if (retentionUpdate !== null) patch.retentionDays = retentionUpdate
    try {
      await editor.edit(entry, (current) => {
        const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
        return { ...base, ...patch }
      })
    } catch (error) {
      return { ok: false, code: 'settings-unavailable', message: '保存设置失败：' + messageOf(error) }
    }

    const fallback = defaultDataDir()
    const currentDataDir = dataDirState()
    const currentRetention = retentionState()
    return {
      ok: true,
      dataDir: dataDirUpdate === null ? currentDataDir.dataDir : dataDirUpdate.isDefault ? fallback : dataDirUpdate.path,
      defaultDataDir: fallback,
      isDefault: dataDirUpdate === null ? currentDataDir.isDefault : dataDirUpdate.isDefault,
      retentionDays: retentionUpdate === null ? currentRetention.retentionDays : retentionUpdate,
    }
  }

  const jobs = new JobManager({
    enginePath: ENGINE_PATH,
    getDataDir: dataDirState,
    onFinished: () => {
      // Fire-and-forget: cleanup must never change the job result or response.
      void runCleanup('job')
    },
    logger: ctx.logger,
    version,
  })
  const getRegistry = () => optionalService(ctx, 'workspaceRegistry')
  const getAgents = () => optionalService(ctx, 'agents')

  let probeCache = null

  /** Run the engine's Env self-check (cached briefly, never throws). */
  async function probeEngine() {
    const now = Date.now()
    if (probeCache !== null && now - probeCache.at < ENGINE_PROBE_TTL_MS) return probeCache.value
    const value = await new Promise((resolve) => {
      let settled = false
      let handle = null
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        try {
          handle?.kill()
        } catch {
          /* already gone */
        }
        finish({ available: false, error: '引擎环境自检超时' })
      }, ENGINE_PROBE_TIMEOUT_MS)
      timer.unref?.()
      try {
        handle = startEngine({
          enginePath: ENGINE_PATH,
          mode: 'Env',
          onEvent: (event) => {
            if (event.type === 'env') {
              finish({
                available: true,
                integrity: typeof event.integrity === 'string' ? event.integrity : 'Unknown',
                user: typeof event.user === 'string' ? event.user : null,
                powershell: typeof event.powershellVersion === 'string' ? event.powershellVersion : null,
                icacls: typeof event.icaclsPath === 'string' ? event.icaclsPath : null,
                canWriteLabel: event.canWriteLabel === true,
              })
              try {
                handle?.kill()
              } catch {
                /* already gone */
              }
            } else if (event.type === 'fatal') {
              finish({ available: false, error: typeof event.message === 'string' ? event.message : '引擎自检失败' })
            }
          },
        })
        handle.done.then((exit) => {
          if (settled) return
          const detail = exit.error ?? (typeof exit.stderr === 'string' && exit.stderr.trim() !== '' ? exit.stderr.trim() : '')
          finish({
            available: false,
            error: '引擎自检未返回环境信息' + (detail !== '' ? '：' + detail.slice(-400) : '（退出码 ' + String(exit.code) + '）'),
          })
        })
      } catch (error) {
        finish({ available: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    probeCache = { at: now, value }
    return value
  }

  const deps = {
    jobs,
    version,
    getDataDir: dataDirState,
    getRetention: retentionState,
    getLastCleanup: () => lastCleanup,
    saveSettings,
    runCleanup: () => runCleanup('manual'),
    enginePath: ENGINE_PATH,
    platform: process.platform,
    logger: ctx.logger,
    openFolder: openFolderInExplorer,
    probeEngine,
    getRegistry,
    getAgents,
  }

  ctx.effect(() => {
    // One pass shortly after activation, then every six hours. Both timers are
    // unref'ed and disposed with the plugin so they can never keep DSH alive.
    const initialTimer = setTimeout(() => {
      void runCleanup('startup')
    }, CLEANUP_START_DELAY_MS)
    initialTimer.unref?.()
    const intervalTimer = setInterval(() => {
      void runCleanup('interval')
    }, CLEANUP_INTERVAL_MS)
    intervalTimer.unref?.()
    return () => {
      clearTimeout(initialTimer)
      clearInterval(intervalTimer)
    }
  }, 'dsh-file-integrity-check: artifact cleanup schedule')

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: createHttpHandler(deps),
    })
    return () => {
      try {
        disposeRoute()
      } finally {
        jobs.dispose()
      }
    }
  }, 'dsh-file-integrity-check: http route')
}
