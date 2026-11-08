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
async function makeDeps({ probe, workspacePath, dataDir, getDataDir, getRetention, getLastCleanup, saveSettings, runCleanup, events, openFolder }) {
  const registry = {
    list: () => [{ id: 'ws-1', path: workspacePath, title: 'Workspace', sessionIds: ['session-1'] }],
    resolveByPath: async (hint) => (path.resolve(hint) === path.resolve(workspacePath) ? { id: 'ws-1', path: workspacePath, title: 'Workspace', sessionIds: [] } : undefined),
  }
  const jobs = new JobManager({
    enginePath: 'C:\\fake\\engine.ps1',
    dataDir,
    getDataDir,
    runEngine: fakeEngine(
      events ?? [
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
      ],
    ),
  })
  return {
    jobs,
    version: '0.1.0',
    dataDir,
    getDataDir,
    getRetention,
    getLastCleanup,
    saveSettings,
    runCleanup,
    enginePath: 'C:\\fake\\engine.ps1',
    platform: 'win32',
    logger: undefined,
    openFolder,
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
    assert.equal(health.json.dataDir, dataDir)
    assert.equal(health.json.defaultDataDir, dataDir)
    assert.equal(health.json.dataDirError, null)

    const diagnostics = await request(harness.base, PREFIX + '/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.json.registry.sample.length, 1)
    assert.equal(diagnostics.json.services.workspaceRegistry, true)
    assert.equal(diagnostics.json.dataDir, dataDir)
    assert.equal(diagnostics.json.defaultDataDir, dataDir)
    assert.equal(diagnostics.json.dataDirError, null)
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

test('scan job lifecycle over HTTP: start, poll, items and export', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const reportPath = path.join(dataDir, 'reports', 'scan-test.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, JSON.stringify({ hits: 1 }), 'utf8')
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    events: [
      { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
      { type: 'hit', path: path.join(workspace, 'a.txt'), kind: 'file', explicit: true },
      {
        type: 'result',
        mode: 'scan',
        scanned: 3,
        hits: 1,
        explicitCount: 1,
        inheritedCount: 0,
        rootLabel: 'Low',
        engineVersion: '0.1.0',
        reportPath,
      },
    ],
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const start = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'scan', sessionId: 'session-1' }),
    })
    assert.equal(start.json.ok, true)
    assert.equal(start.json.depth, 'quick')
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
    assert.equal(exported.status, 200)
    assert.equal(exported.json.ok, true)
    assert.equal(exported.json.fromEngine, true)
    assert.equal(exported.json.path, reportPath)
    const payload = JSON.parse(await fs.readFile(exported.json.path, 'utf8'))
    assert.equal(payload.hits, 1)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('scan export without an engine report returns 400 no-report', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    events: [
      { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
      {
        type: 'result',
        mode: 'scan',
        scanned: 3,
        hits: 0,
        explicitCount: 0,
        inheritedCount: 0,
        rootLabel: 'Medium',
        engineVersion: '0.1.0',
      },
    ],
  })
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
    let job = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const poll = await request(harness.base, PREFIX + '/jobs/' + jobId)
      job = poll.json.job
      if (job.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(job.status, 'succeeded')

    const exported = await request(harness.base, PREFIX + '/jobs/' + jobId + '/export', { method: 'POST', headers, body: '{}' })
    assert.equal(exported.status, 400)
    assert.equal(exported.json.ok, false)
    assert.equal(exported.json.code, 'no-report')
    assert.equal(exported.json.message, '本次扫描没有可导出的报告（未生成或写入失败）')
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

test('open-folder only opens the plugin snapshots directory and validates the job', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const snapshotsRoot = path.join(dataDir, 'snapshots')
  await fs.mkdir(snapshotsRoot, { recursive: true })
  const snapshotPath = path.join(snapshotsRoot, 'snapshot-test.json')
  const restorePath = path.join(snapshotsRoot, 'restore-test.ps1')
  const reportsRoot = path.join(dataDir, 'reports')
  await fs.mkdir(reportsRoot, { recursive: true })
  const reportPath = path.join(reportsRoot, 'scan-test.json')
  await fs.writeFile(snapshotPath, '{}', 'utf8')
  await fs.writeFile(restorePath, '# restore', 'utf8')
  await fs.writeFile(reportPath, '{}', 'utf8')
  const opened = []
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    events: [
      { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
      {
        type: 'result',
        mode: 'repair',
        scanned: 1,
        hits: 1,
        fixed: 1,
        failed: [],
        remaining: 0,
        snapshotPath,
        restorePath,
        engineVersion: '0.1.0',
      },
    ],
    openFolder: async (folder) => {
      opened.push(folder)
    },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const start = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'repair', sessionId: 'session-1' }),
    })
    assert.equal(start.json.ok, true)
    const jobId = start.json.jobId
    let job = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const poll = await request(harness.base, PREFIX + '/jobs/' + jobId)
      job = poll.json.job
      if (job.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(job.status, 'succeeded')
    assert.equal(job.snapshotPath, snapshotPath)

    // The pinned job.dataDir is authoritative: a later settings change (or a
    // stale deps.dataDir) must not redirect the folder that gets opened.
    deps.dataDir = path.join(os.tmpdir(), 'dsh-fi-unrelated-data')

    const openedRes = await request(harness.base, PREFIX + '/open-folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
    })
    assert.equal(openedRes.status, 200)
    assert.equal(openedRes.json.ok, true)
    assert.equal(opened.length, 1)
    assert.equal(path.resolve(opened[0]), path.resolve(snapshotsRoot))

    const missing = await request(harness.base, PREFIX + '/open-folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: 'does-not-exist' }),
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'job-not-found')

    // A job whose artifact path escaped the snapshots root must be rejected.
    const managerJob = deps.jobs.get(jobId)
    managerJob.reportPath = reportPath
    const reportOpened = await request(harness.base, PREFIX + '/open-folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId, target: 'report' }),
    })
    assert.equal(reportOpened.json.ok, true)
    assert.equal(opened.length, 2)
    assert.equal(path.resolve(opened[1]), path.resolve(reportsRoot))

    managerJob.snapshotPath = path.join(workspace, 'evil.json')
    const escaped = await request(harness.base, PREFIX + '/open-folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
    })
    assert.equal(escaped.status, 403)
    assert.equal(escaped.json.code, 'forbidden')
    assert.equal(opened.length, 2)

    deps.platform = 'darwin'
    const wrongPlatform = await request(harness.base, PREFIX + '/open-folder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
    })
    assert.equal(wrongPlatform.json.ok, false)
    assert.equal(wrongPlatform.json.code, 'unsupported-platform')
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('settings endpoints expose and persist dataDir and retentionDays', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const defaultDir = path.join(dataDir, 'default')
  const live = { dataDir: defaultDir, retentionDays: 30, isDefault: true, error: null, lastCleanup: null }
  const patches = []
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    getDataDir: () => ({ dataDir: live.dataDir, defaultDataDir: defaultDir, isDefault: live.isDefault, error: live.error }),
    getRetention: () => ({ retentionDays: live.retentionDays, error: null }),
    getLastCleanup: () => live.lastCleanup,
    saveSettings: async (patch) => {
      patches.push(patch)
      if (Object.prototype.hasOwnProperty.call(patch, 'dataDir')) {
        if (patch.dataDir === '') {
          live.dataDir = defaultDir
          live.isDefault = true
        } else {
          live.dataDir = patch.dataDir
          live.isDefault = false
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'retentionDays')) live.retentionDays = patch.retentionDays
      return {
        ok: true,
        dataDir: live.dataDir,
        defaultDataDir: defaultDir,
        isDefault: live.isDefault,
        retentionDays: live.retentionDays,
      }
    },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  const post = (body) => request(harness.base, PREFIX + '/settings', { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const read = await request(harness.base, PREFIX + '/settings')
    assert.equal(read.status, 200)
    assert.deepEqual(read.json, {
      ok: true,
      dataDir: defaultDir,
      defaultDataDir: defaultDir,
      isDefault: true,
      error: null,
      retentionDays: 30,
      retentionPresets: [3, 7, 15, 30],
      lastCleanup: null,
    })

    const saveDir = await post({ dataDir: 'D:\\integrity-data' })
    assert.equal(saveDir.status, 200)
    assert.deepEqual(saveDir.json, {
      ok: true,
      dataDir: 'D:\\integrity-data',
      defaultDataDir: defaultDir,
      isDefault: false,
      retentionDays: 30,
    })
    assert.deepEqual(patches, [{ dataDir: 'D:\\integrity-data' }])

    const saveRetention = await post({ retentionDays: 7 })
    assert.equal(saveRetention.status, 200)
    assert.deepEqual(saveRetention.json, {
      ok: true,
      dataDir: 'D:\\integrity-data',
      defaultDataDir: defaultDir,
      isDefault: false,
      retentionDays: 7,
    })
    assert.deepEqual(patches, [{ dataDir: 'D:\\integrity-data' }, { retentionDays: 7 }])

    // Both fields are merged into one configEditor write.
    const combined = await post({ dataDir: '', retentionDays: 15 })
    assert.equal(combined.status, 200)
    assert.deepEqual(combined.json, {
      ok: true,
      dataDir: defaultDir,
      defaultDataDir: defaultDir,
      isDefault: true,
      retentionDays: 15,
    })
    assert.deepEqual(patches, [{ dataDir: 'D:\\integrity-data' }, { retentionDays: 7 }, { dataDir: '', retentionDays: 15 }])

    // The GET endpoint reads live values (volatile) and reports the last cleanup.
    live.lastCleanup = { at: 123, cutoff: 100, deletedCount: 2, freedBytes: 10, error: null }
    const readAgain = await request(harness.base, PREFIX + '/settings')
    assert.equal(readAgain.json.dataDir, defaultDir)
    assert.equal(readAgain.json.retentionDays, 15)
    assert.deepEqual(readAgain.json.lastCleanup, { at: 123, cutoff: 100, deletedCount: 2, freedBytes: 10, error: null })
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('settings reject malformed patches without touching storage', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const calls = []
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    saveSettings: async (patch) => {
      calls.push(patch)
      return { ok: true, dataDir, defaultDataDir: dataDir, isDefault: true, retentionDays: 30 }
    },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  const post = (body) => request(harness.base, PREFIX + '/settings', { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const empty = await post({})
    assert.equal(empty.status, 400)
    assert.equal(empty.json.code, 'settings-invalid')
    assert.match(empty.json.message, /至少需要提供/)

    for (const value of [42, null, [], {}]) {
      const response = await post({ dataDir: value })
      assert.equal(response.status, 400, JSON.stringify(value))
      assert.equal(response.json.code, 'settings-invalid')
    }
    for (const value of [0, 3651, 3.5, -1, '7', null, true]) {
      const response = await post({ retentionDays: value })
      assert.equal(response.status, 400, JSON.stringify(value))
      assert.equal(response.json.code, 'settings-invalid')
      assert.match(response.json.message, /保留天数/)
    }
    assert.deepEqual(calls, [])
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('settings failures map to 400/501 and a missing saver is 501', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    saveSettings: async (patch) => {
      if (patch.dataDir === 'invalid') return { ok: false, code: 'settings-invalid', message: '产物目录无效' }
      if (patch.dataDir === 'unwritable') return { ok: false, code: 'settings-unwritable', message: '产物目录不可写' }
      return { ok: false, code: 'settings-unavailable', message: '配置服务不可用' }
    },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  const post = (body) => request(harness.base, PREFIX + '/settings', { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    const invalid = await post({ dataDir: 'invalid' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.code, 'settings-invalid')
    assert.equal(invalid.json.message, '产物目录无效')

    const unwritable = await post({ dataDir: 'unwritable' })
    assert.equal(unwritable.status, 400)
    assert.equal(unwritable.json.code, 'settings-unwritable')

    const unavailable = await post({ dataDir: 'gone' })
    assert.equal(unavailable.status, 501)
    assert.equal(unavailable.json.code, 'settings-unavailable')

    // A Host without the configEditor-backed saver reports settings-unavailable.
    deps.saveSettings = undefined
    const missing = await post({ dataDir: 'D:\\data' })
    assert.equal(missing.status, 501)
    assert.equal(missing.json.code, 'settings-unavailable')
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('a successful save triggers cleanup in the background without blocking', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  let cleanupCalls = 0
  let releaseCleanup = () => {}
  const pendingCleanup = new Promise((resolve) => {
    releaseCleanup = resolve
  })
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    saveSettings: async () => ({ ok: true, dataDir, defaultDataDir: dataDir, isDefault: true, retentionDays: 7 }),
    runCleanup: () => {
      cleanupCalls += 1
      return pendingCleanup
    },
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const saved = await request(harness.base, PREFIX + '/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ retentionDays: 7 }),
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.retentionDays, 7)
    assert.equal(cleanupCalls, 1)
  } finally {
    releaseCleanup(null)
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('diagnostics expose retention state and the last cleanup', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const lastCleanup = { at: 111, cutoff: 222, deletedCount: 3, freedBytes: 99, error: '部分文件删除失败（1 项错误）' }
  const retentionError = '保留天数配置无效（需要 1..3650 的整数），已回退默认 30 天'
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    getRetention: () => ({ retentionDays: 30, error: retentionError }),
    getLastCleanup: () => lastCleanup,
  })
  const harness = await startTestServer(deps)
  try {
    const diagnostics = await request(harness.base, PREFIX + '/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.json.retentionDays, 30)
    assert.equal(diagnostics.json.retentionError, retentionError)
    assert.deepEqual(diagnostics.json.lastCleanup, lastCleanup)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('health and diagnostics report a rejected product directory', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const fallback = path.join(dataDir, 'low-integrity-check')
  const error = '产物目录配置无效：不能使用磁盘根目录；已回退默认目录'
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    getDataDir: () => ({ dataDir: fallback, defaultDataDir: fallback, isDefault: true, error }),
  })
  const harness = await startTestServer(deps)
  try {
    const health = await request(harness.base, PREFIX + '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.dataDir, fallback)
    assert.equal(health.json.defaultDataDir, fallback)
    assert.equal(health.json.dataDirError, error)
    assert.ok(health.json.warnings.some((warning) => warning.includes('产物目录配置不可用')))

    const diagnostics = await request(harness.base, PREFIX + '/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.json.dataDir, fallback)
    assert.equal(diagnostics.json.defaultDataDir, fallback)
    assert.equal(diagnostics.json.dataDirError, error)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('a job whose product directory sits inside the workspace is rejected with 400', async () => {
  const dataDir = await tempDir()
  const workspace = await tempDir()
  const inner = path.join(workspace, 'artifacts')
  const deps = await makeDeps({
    workspacePath: workspace,
    dataDir,
    getDataDir: () => ({ dataDir: inner, defaultDataDir: dataDir, isDefault: false, error: null }),
  })
  const harness = await startTestServer(deps)
  const headers = { 'content-type': 'application/json', origin: harness.base }
  try {
    const rejected = await request(harness.base, PREFIX + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'scan', sessionId: 'session-1' }),
    })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.json.ok, false)
    assert.equal(rejected.json.code, 'data-dir-inside-workspace')
    assert.equal(deps.jobs.jobs.size, 0)
  } finally {
    deps.jobs.dispose()
    await harness.close()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
