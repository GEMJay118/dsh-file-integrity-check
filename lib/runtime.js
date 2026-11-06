/**
 * Wire the Host plugin into one Cordis context: probe, jobs, HTTP route.
 * @module dsh-low-integrity-check/lib/runtime
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startEngine } from './engine.js'
import { JobManager } from './jobs.js'
import { createHttpHandler, PREFIX } from './routes.js'
import { dshHomeDir } from './paths.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_PATH = path.join(PKG_ROOT, 'engine', 'integrity.ps1')
const ENGINE_PROBE_TTL_MS = 60 * 1000
const ENGINE_PROBE_TIMEOUT_MS = 20 * 1000

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

/** Soft-get one optional DSH service without throwing on a strict ctx. */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* service absent or not injectable */
  }
  return undefined
}

/**
 * Create the runtime for one plugin activation.
 * @param {object} ctx Cordis context with webServer injected
 */
export function createRuntime(ctx) {
  const version = packageVersion()
  const dataDir = path.join(dshHomeDir(), 'low-integrity-check')
  const jobs = new JobManager({ enginePath: ENGINE_PATH, dataDir, logger: ctx.logger, version })
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
    dataDir,
    enginePath: ENGINE_PATH,
    platform: process.platform,
    logger: ctx.logger,
    probeEngine,
    getRegistry,
    getAgents,
  }

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
  }, 'dsh-low-integrity-check: http route')
}
