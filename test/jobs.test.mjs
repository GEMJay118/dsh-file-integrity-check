import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobManager, fileStamp, safeSegment, uniquePath } from '../lib/jobs.js'

const WORKSPACE = { id: 'ws-1', path: 'C:\\fake\\workspace', title: 'workspace' }

/** Fake engine that feeds the given events then exits. */
function fakeEngine(events, exit = { code: 0, stderr: '' }) {
  return ({ onEvent }) => {
    const handle = {
      done: Promise.resolve(exit),
      kill: () => {},
      getStderr: () => exit.stderr ?? '',
    }
    queueMicrotask(() => {
      for (const event of events) onEvent(event)
    })
    return handle
  }
}

/** Fake engine that stays running until killed. */
function controllableEngine() {
  const state = { onEvent: null, resolveDone: null }
  state.run = ({ onEvent }) => {
    state.onEvent = onEvent
    const done = new Promise((resolve) => {
      state.resolveDone = resolve
    })
    return {
      done,
      kill: () => {
        state.resolveDone?.({ code: 0, stderr: '' })
      },
      getStderr: () => '',
    }
  }
  return state
}

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-jobs-'))
}

async function waitTerminal(manager, jobId, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const job = manager.get(jobId)
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle: ' + JSON.stringify(manager.get(jobId)))
}

function makeManager(runEngine, dataDir = 'C:\\fake\\data') {
  return new JobManager({ enginePath: 'C:\\fake\\engine.ps1', dataDir, runEngine })
}

test('scan job accumulates hits, counts and errors', async () => {
  const dataDir = await tempDir()
  try {
    const manager = makeManager(
      fakeEngine([
        { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
        { type: 'progress', phase: 'read', scanned: 5, total: 10, hits: 1 },
        { type: 'hit', path: 'C:\\fake\\workspace\\a.txt', kind: 'file', explicit: true },
        { type: 'hit', path: 'C:\\fake\\workspace\\sub', kind: 'dir', explicit: false },
        { type: 'error', path: 'C:\\fake\\workspace\\locked', message: 'access denied' },
        {
          type: 'result',
          mode: 'scan',
          scanned: 10,
          hits: 2,
          explicitCount: 1,
          inheritedCount: 1,
          rootLabel: 'Low',
          engineVersion: '0.1.0',
        },
      ]),
      dataDir,
    )
    const started = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
    assert.equal(started.ok, true)
    const job = await waitTerminal(manager, started.jobId)
    assert.equal(job.status, 'succeeded')
    assert.equal(job.scanned, 10)
    assert.equal(job.hits, 2)
    assert.equal(job.explicitCount, 1)
    assert.equal(job.inheritedCount, 1)
    assert.equal(job.rootLabel, 'Low')
    assert.equal(job.errorCount, 1)
    assert.equal(job.items.length, 2)

    const snapshot = manager.snapshot(job)
    assert.equal(snapshot.items.length, 2)
    assert.equal(snapshot.truncated, false)
    assert.equal(snapshot.env.integrity, 'Medium')

    const page = manager.itemsPage(job, 1, 1)
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].path, 'C:\\fake\\workspace\\sub')
    manager.dispose()
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('completed scan exports a JSON report', async () => {
  const dataDir = await tempDir()
  try {
    const manager = makeManager(
      fakeEngine([
        { type: 'hit', path: 'C:\\fake\\workspace\\a.txt', kind: 'file', explicit: true },
        { type: 'result', mode: 'scan', scanned: 3, hits: 1, explicitCount: 1, inheritedCount: 0, rootLabel: 'Low' },
      ]),
      dataDir,
    )
    const started = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
    const job = await waitTerminal(manager, started.jobId)
    const result = await manager.exportScan(job)
    assert.equal(result.ok, true)
    const payload = JSON.parse(await fs.readFile(result.path, 'utf8'))
    assert.equal(payload.workspacePath, WORKSPACE.path)
    assert.equal(payload.rootLabel, 'Low')
    assert.equal(payload.hits, 1)
    assert.equal(payload.items.length, 1)
    assert.equal(payload.exportedAt.length > 10, true)
    manager.dispose()
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('partial repair fails and writes a failure log with details', async () => {
  const dataDir = await tempDir()
  try {
    const manager = makeManager(
      fakeEngine([
        { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
        { type: 'hit', path: 'C:\\fake\\workspace\\a.txt', kind: 'file', explicit: true },
        {
          type: 'result',
          mode: 'repair',
          fixed: 1,
          snapshotPath: 'C:\\fake\\data\\snapshots\\repair-1.json',
          restorePath: 'C:\\fake\\data\\snapshots\\restore-1.ps1',
          failed: [{ path: 'C:\\fake\\workspace\\a.txt', message: 'Access is denied.', output: 'C:\\fake\\workspace\\a.txt: Access is denied.' }],
        },
      ]),
      dataDir,
    )
    const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
    const job = await waitTerminal(manager, started.jobId)
    assert.equal(job.status, 'failed')
    assert.equal(job.failedCount, 1)
    assert.equal(job.fixed, 1)
    assert.match(job.message, /清除失败（1 项）/)

    const logged = await manager.writeLog(job)
    const text = await fs.readFile(logged.path, 'utf8')
    assert.match(text, /failure log/)
    assert.match(text, /Access is denied/)
    assert.match(text, /snapshotPath/)
    assert.match(text, /integrity/)
    manager.dispose()
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('repair aborts before touching labels when the engine is sandboxed', async () => {
  const manager = makeManager(
    fakeEngine([
      { type: 'env', user: 'tester', integrity: 'Low', canWriteLabel: false },
    ]),
  )
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = await waitTerminal(manager, started.jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.messageCode, 'engine-sandboxed')
  assert.match(job.message, /无法修改完整性标签/)
  manager.dispose()
})

test('one workspace runs one job at a time', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const first = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
  assert.equal(first.ok, true)
  const second = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'busy')
  manager.requestCancel(first.jobId, 'user')
  const job = await waitTerminal(manager, first.jobId)
  assert.equal(job.status, 'cancelled')
  manager.dispose()
})

test('cancel marks a running job cancelled', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
  assert.equal(manager.requestCancel(started.jobId, 'user').ok, true)
  const job = await waitTerminal(manager, started.jobId)
  assert.equal(job.status, 'cancelled')
  assert.match(job.message, /已取消/)
  manager.dispose()
})

test('successful repair reports success and snapshot paths', async () => {
  const manager = makeManager(
    fakeEngine([
      { type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true },
      { type: 'hit', path: 'C:\\fake\\workspace\\a.txt', kind: 'file', explicit: true },
      {
        type: 'result',
        mode: 'repair',
        fixed: 2,
        failed: [],
        remaining: 0,
        snapshotPath: 'C:\\fake\\data\\snapshots\\snapshot-1.json',
        restorePath: 'C:\\fake\\data\\snapshots\\restore-1.ps1',
      },
    ]),
  )
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = await waitTerminal(manager, started.jobId)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.fixed, 2)
  assert.equal(job.failedCount, 0)
  assert.equal(job.remainingCount, 0)
  assert.equal(job.snapshotPath, 'C:\\fake\\data\\snapshots\\snapshot-1.json')
  assert.equal(job.restorePath, 'C:\\fake\\data\\snapshots\\restore-1.ps1')
  const snapshot = manager.snapshot(job)
  assert.equal(snapshot.remainingCount, 0)
  assert.deepEqual(snapshot.failed, [])
  manager.dispose()
})

test('unknown job ids are reported as job-not-found', () => {
  const manager = makeManager(fakeEngine([]))
  assert.equal(manager.get('missing'), undefined)
  assert.equal(manager.requestCancel('missing').code, 'job-not-found')
  manager.dispose()
})

test('engine failure without a result reports the exit code', async () => {
  const manager = makeManager(fakeEngine([{ type: 'progress', phase: 'read', scanned: 1 }], { code: 2, stderr: 'boom' }))
  const started = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
  const job = await waitTerminal(manager, started.jobId)
  assert.equal(job.status, 'failed')
  assert.match(job.message, /引擎异常退出（退出码 2）/)
  manager.dispose()
})

test('file stamp, safe segment and unique path helpers', async () => {
  assert.match(fileStamp(Date.UTC(2026, 10, 6, 7, 8, 9)), /^2026\d{4}-\d{6}$/)
  assert.equal(safeSegment('my work: v1?'), 'my work_ v1_')
  assert.equal(safeSegment('   '), 'workspace')
  assert.equal(safeSegment('..'), 'workspace')

  const dir = await tempDir()
  try {
    const first = path.join(dir, 'a.json')
    await fs.writeFile(first, '{}', 'utf8')
    const second = await uniquePath(first)
    assert.notEqual(second, first)
    assert.match(second, /a-2\.json$/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
