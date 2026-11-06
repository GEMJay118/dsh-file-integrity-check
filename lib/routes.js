/**
 * HTTP surface of the plugin. Same-origin only; the browser supplies a
 * session id, never a filesystem path.
 * @module dsh-low-integrity-check/lib/routes
 */
import { countLiveAgents, resolveWorkspace } from './paths.js'
import { LIMITS } from './jobs.js'

/** Route prefix registered on the DSH web server. */
export const PREFIX = '/dsh-low-integrity-check'

/** Maximum accepted JSON body size. */
const MAX_BODY_BYTES = 256 * 1024

/** Platform this plugin supports. */
export const SUPPORTED_PLATFORM = 'win32'

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Same-origin check based on the request's own Host header. */
function originAllowed(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const parsed = new URL(origin)
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    return host !== '' && parsed.host === host
  } catch {
    return false
  }
}

/** Read and parse a small JSON body. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'invalid-request' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'invalid-request' }))
          return
        }
        resolve(parsed)
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'invalid-request' }))
      }
    })
    req.on('error', (error) => reject(Object.assign(error, { code: 'invalid-request' })))
  })
}

/**
 * Build the request handler.
 * @param {object} deps
 * @param {() => Promise<object>} deps.probeEngine
 * @param {() => object|undefined} deps.getRegistry
 * @param {() => object|undefined} deps.getAgents
 * @param {import('./jobs.js').JobManager} deps.jobs
 * @param {string} deps.version
 * @param {string} deps.dataDir
 * @param {string} deps.enginePath
 * @param {string} deps.platform
 * @param {object} [deps.logger]
 */
export function createHttpHandler(deps) {
  async function handleWorkspace(body) {
    if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
      return { ok: false, code: 'invalid-request', message: '缺少 sessionId' }
    }
    const resolution = await resolveWorkspace({
      sessionId: body.sessionId,
      registry: deps.getRegistry(),
      hintPath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
    })
    if (!resolution.ok) return resolution
    const liveAgentCount = countLiveAgents(deps.getAgents(), resolution.sessionIds ?? [])
    const warnings = []
    if (liveAgentCount > 0) {
      warnings.push(
        '当前工作区有 ' + liveAgentCount + ' 个活跃会话：清除后只要有 workspace-write 写入，DSH 可能重新写入 Low 标签，建议停用其他会话后再复核。',
      )
    }
    warnings.push('DSH 在 workspace-write 模式下可能再次为工作区写入 Low 标签；本插件不保证标签不再复发。')
    return {
      ok: true,
      workspace: resolution.workspace,
      sessionCount: resolution.sessionCount,
      liveAgentCount,
      warnings,
    }
  }

  return async function handler(req, res) {
    try {
      if (!originAllowed(req)) {
        fail(res, 403, 'forbidden', '只接受同源请求')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname
      if (!pathname.startsWith(PREFIX)) {
        fail(res, 404, 'not-found', '未知路由')
        return
      }
      const rest = pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && rest === '/health') {
        const probe = await deps.probeEngine()
        const registry = deps.getRegistry()
        let count = 0
        try {
          count = registry && typeof registry.list === 'function' ? registry.list().length : 0
        } catch {
          count = 0
        }
        const warnings = []
        if (probe.available !== true) {
          warnings.push('引擎环境自检未通过：' + (probe.error ?? '未知原因'))
        } else if (probe.canWriteLabel !== true) {
          warnings.push('引擎运行在 ' + String(probe.integrity) + ' 完整性，只读检查可用，但无法修复标签。')
        }
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          platform: deps.platform,
          engine: probe,
          registry: {
            available: registry !== undefined && registry !== null,
            count,
            resolveByPath: registry !== undefined && typeof registry?.resolveByPath === 'function',
          },
          warnings,
        })
        return
      }

      if (method === 'GET' && rest === '/diagnostics') {
        const registry = deps.getRegistry()
        let entries = []
        try {
          entries = registry && typeof registry.list === 'function' ? registry.list() : []
        } catch {
          entries = []
        }
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          platform: deps.platform,
          origin: typeof req.headers.host === 'string' ? req.headers.host : '',
          dataDir: deps.dataDir,
          enginePath: deps.enginePath,
          engineProbe: await deps.probeEngine(),
          services: {
            workspaceRegistry: registry !== undefined && registry !== null,
            agents: deps.getAgents() !== undefined && deps.getAgents() !== null,
          },
          registry: {
            available: registry !== undefined && registry !== null,
            resolveByPath: registry !== undefined && typeof registry?.resolveByPath === 'function',
            count: entries.length,
            sample: entries.slice(0, 10).map((workspace) => ({
              id: typeof workspace.id === 'string' ? workspace.id : '',
              title: typeof workspace.title === 'string' ? workspace.title : '',
              path: typeof workspace.path === 'string' ? workspace.path : '',
              sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
            })),
          },
        })
        return
      }

      if (method === 'POST') {
        const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
        if (!contentType.toLowerCase().includes('application/json')) {
          fail(res, 415, 'invalid-request', '请求必须使用 application/json')
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          fail(res, 400, 'invalid-request', messageOf(error))
          return
        }

        if (rest === '/workspace') {
          const result = await handleWorkspace(body)
          sendJson(res, result.ok ? 200 : 200, result)
          return
        }

        if (rest === '/jobs') {
          if (deps.platform !== SUPPORTED_PLATFORM) {
            fail(res, 200, 'unsupported-platform', '该功能仅支持 Windows')
            return
          }
          const action = body.action === 'repair' ? 'repair' : body.action === 'scan' ? 'scan' : null
          if (action === null) {
            fail(res, 400, 'invalid-request', 'action 必须是 scan 或 repair')
            return
          }
          const depth = body.depth === 'deep' ? 'deep' : 'quick'
          if (action === 'repair') {
            const probe = await deps.probeEngine()
            if (probe.available !== true) {
              fail(res, 200, 'engine-unavailable', '引擎不可用：' + (probe.error ?? '未知原因'))
              return
            }
            if (probe.canWriteLabel !== true) {
              fail(
                res,
                200,
                'engine-sandboxed',
                '宿主派生的 PowerShell 仍受限（完整性 ' + String(probe.integrity) + '），无法清除标签；请检查启动方式',
              )
              return
            }
          }
          const resolution = await resolveWorkspace({
            sessionId: body.sessionId,
            registry: deps.getRegistry(),
            hintPath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
          })
          if (!resolution.ok) {
            sendJson(res, 200, resolution)
            return
          }
          const started = deps.jobs.start({
            action,
            workspace: resolution.workspace,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            depth,
          })
          if (!started.ok) {
            sendJson(res, 200, started)
            return
          }
          sendJson(res, 200, {
            ok: true,
            jobId: started.jobId,
            depth: action === 'scan' ? depth : null,
            workspace: resolution.workspace,
            warnings:
              action === 'repair'
                ? ['workspace-write 会话活跃时，DSH 可能在清除后重新写入 Low 标签。']
                : [],
          })
          return
        }

        const jobMatch = /^\/jobs\/([A-Za-z0-9-]+)\/(cancel|export|log)$/.exec(rest)
        if (jobMatch !== null) {
          const job = deps.jobs.get(jobMatch[1])
          if (job === undefined) {
            fail(res, 404, 'job-not-found', '任务不存在或已过期')
            return
          }
          const verb = jobMatch[2]
          if (verb === 'cancel') {
            const result = deps.jobs.requestCancel(job.id, 'user')
            sendJson(res, 200, result)
            return
          }
          if (verb === 'export') {
            const result = await deps.jobs.exportScan(job)
            sendJson(res, result.ok ? 200 : 400, result)
            return
          }
          const result = await deps.jobs.writeLog(job)
          sendJson(res, 200, result)
          return
        }

        fail(res, 404, 'not-found', '未知路由')
        return
      }

      if (method === 'GET') {
        const jobMatch = /^\/jobs\/([A-Za-z0-9-]+)(\/items)?$/.exec(rest)
        if (jobMatch !== null) {
          const job = deps.jobs.get(jobMatch[1])
          if (job === undefined) {
            fail(res, 404, 'job-not-found', '任务不存在或已过期')
            return
          }
          if (jobMatch[2] === '/items') {
            const url2 = url
            sendJson(res, 200, {
              ok: true,
              ...deps.jobs.itemsPage(
                job,
                Number(url2.searchParams.get('offset') ?? 0),
                Number(url2.searchParams.get('limit') ?? LIMITS.FIRST_PAGE),
              ),
            })
            return
          }
          sendJson(res, 200, { ok: true, job: deps.jobs.snapshot(job) })
          return
        }
      }

      fail(res, 404, 'not-found', '未知路由')
    } catch (error) {
      try {
        deps.logger?.warn?.('[dsh-low-integrity-check] route failed: ' + messageOf(error))
      } catch {
        /* logging must never break the response */
      }
      if (!res.writableEnded) fail(res, 500, 'internal-error', '插件内部错误')
    }
  }
}
