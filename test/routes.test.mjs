import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobManager } from '../lib/jobs.js'
import { PREFIX, createHttpHandler } from '../lib/routes.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-routes-'))
}

function fakeEngine(events) {
  return ({ onEvent }) => {
    const handle = { done: Promise.resolve({ code: 0, stderr: '' }), kill: () => {}, getStderr: () => '' }
    queueMicrotask(() => {
      for (const event of events) onEvent(event)
    })
    return handle
  }
}

async function startTestServer(deps) {
  const server = createServer(createHttpHandler(deps))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = 'http://127.0.0.1:' + port
  return {
    server,
    port,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** Build deps sharing one workspace fixture and job manager. */
async function makeDeps({ probe, workspacePath, dataDir }) {
  const registry = {
    list: () => [{ id: 'ws-1', path: workspacePath, title: 'Workspace', sessionIds: ['session-1'] }],
    resolveByPath: async (hint) => (path.resolve(hint) === path.resolve(workspacePath) ? { id: 'ws-1', path: workspacePath, title: 'Workspace', sessionIds: [] } : undefined),
  }
  const jobs = new JobManager({
    enginePath: 'C:\\fake\\engine.ps1',
    dataDir,
    runEngine: fakeEngine([
      { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
      { type: 'hit', path: path.join(workspacePath, 'a.txt'), kind: 'file', explicit: true },
      {
        type: 'result',
        mode: 'scan',
        scanned: 3,
        hits: 1,
        explicitCount: 1,
        inheritedCount: 0,
        rootLabel: 'Low',
        engineVersion: '0.1.0',
      },
    ]),
  })
  return {
    jobs,
    version: '0.1.0',
    dataDir,
    enginePath: 'C:\\fake\\engine.ps1',
    platform: 'win32',
    logger: undefined,
    probeEngine: async () => probe ?? { available: true, integrity: 'Medium', canWriteLabel: true, user: 'tester', powershell: '5.1', icacls: 'icacls.exe' },
    getRegistry: () => registry,
    getAgents: () => ({ list: () => [{ id: 'session-1' }, { id: 'other' }] }),
  }
}

test('health and diagnostics expose engine and registry state', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({ workspacePath: workspace, dataDir })
  const harness = await startTestServer(deps)
  try {
    const health = await request(harness.base, PREFIX + '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.platform, 'win32')
    assert.equal(health.json.engine.integrity, 'Medium')
    assert.equal(health.json.registry.available, true)
    assert.equal(health.json.registry.count, 1)
    assert.equal(health.json.registry.resolveByPath, true)

    const diagnostics = await request(harness.base, PREFIX + '/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.json.registry.sample.length, 1)
    assert.equal(diagnostics.json.services.workspaceRegistry, true)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('workspace resolution rejects unknown sessions and foreign origins', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({ workspacePath: workspace, dataDir })
  const harness = await startTestServer(deps)
  try {
    const headers = { 'content-type': 'application/json', origin: harness.base }
    const ok = await request(harness.base, PREFIX + '/workspace', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(path.resolve(ok.json.workspace.path), path.resolve(ok.json.workspace.path))
    assert.equal(ok.json.liveAgentCount, 1)

    const unknown = await request(harness.base, PREFIX + '/workspace', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.code, 'workspace-not-found')

    const foreign = await request(harness.base, PREFIX + '/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example:1234' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
    assert.equal(foreign.status, 403)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('scan job lifecycle over HTTP: start, poll, items, export and log', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({ workspacePath: workspace, dataDir })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const start = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'scan', sessionId: 'session-1' }),
    })
    assert.equal(start.json.ok, true)
    const jobId = start.json.jobId
    assert.equal(typeof jobId, 'string')

    let job = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const poll = await request(harness.base, PREFIX + '/jobs/' + jobId)
      assert.equal(poll.status, 200)
      job = poll.json.job
      if (job.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(job.status, 'succeeded')
    assert.equal(job.hits, 1)
    assert.equal(job.rootLabel, 'Low')
    assert.equal(job.items.length, 1)

    const items = await request(harness.base, PREFIX + '/jobs/' + jobId + '/items?offset=0&limit=200')
    assert.equal(items.json.total, 1)
    assert.equal(items.json.items.length, 1)

    const exported = await request(harness.base, PREFIX + '/jobs/' + jobId + '/export', { method: 'POST', headers, body: '{}' })
    assert.equal(exported.json.ok, true)
    const payload = JSON.parse(await fs.readFile(exported.json.path, 'utf8'))
    assert.equal(payload.hits, 1)

    const logged = await request(harness.base, PREFIX + '/jobs/' + jobId + '/log', { method: 'POST', headers, body: '{}' })
    assert.equal(logged.json.ok, true)
    const logText = await fs.readFile(logged.json.path, 'utf8')
    assert.match(logText, /scan/)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('repair is rejected when the engine cannot write labels, and unknown jobs 404', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    probe: { available: true, integrity: 'Low', canWriteLabel: false, user: 'tester' },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const rejected = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'repair', sessionId: 'session-1' }),
    })
    assert.equal(rejected.json.ok, false)
    assert.equal(rejected.json.code, 'engine-sandboxed')

    const missing = await request(harness.base, PREFIX + '/jobs/does-not-exist')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'job-not-found')

    const wrongType = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers: { origin: harness.base },
      body: '{}',
    })
    assert.equal(wrongType.status, 415)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
