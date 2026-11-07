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

test('scan depth defaults to quick and persists deep when requested', async () => {
  const manager = makeManager(
    fakeEngine([
      { type: 'result', mode: 'scan', scanned: 1, hits: 0, explicitCount: 0, inheritedCount: 0, rootLabel: 'Medium' },
    ]),
  )
  const quickStart = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
  assert.equal(manager.get(quickStart.jobId).depth, 'quick')
  assert.equal(manager.get(quickStart.jobId).itemsScope, 'explicit')
  await waitTerminal(manager, quickStart.jobId)

  const deepStart = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1', depth: 'deep' })
  assert.equal(manager.get(deepStart.jobId).depth, 'deep')
  assert.equal(manager.get(deepStart.jobId).itemsScope, 'all')
  const job = await waitTerminal(manager, deepStart.jobId)
  assert.equal(manager.snapshot(job).depth, 'deep')
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

test('repair progress carries hits/fixed/total and keeps items empty', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = manager.get(started.jobId)
  assert.equal(typeof engine.onEvent, 'function')

  engine.onEvent({ type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true })

  // enumerate phase: no usable total yet.
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 40 })
  assert.equal(job.phase, 'enumerate')
  assert.equal(job.total, null)
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 80, total: null })
  assert.equal(job.total, null)

  // repair phase: total is the hit count; hits/fixed are cumulative.
  engine.onEvent({ type: 'progress', phase: 'repair', scanned: 1, total: 5, hits: 5, fixed: 1 })
  assert.equal(job.phase, 'repair')
  assert.equal(job.total, 5)
  assert.equal(job.hits, 5)
  assert.equal(job.fixed, 1)
  // A stale/lower sample must not roll the cumulative counters back.
  engine.onEvent({ type: 'progress', phase: 'repair', scanned: 2, total: 5, hits: 4, fixed: 0 })
  assert.equal(job.hits, 5)
  assert.equal(job.fixed, 1)
  assert.equal(job.items.length, 0)

  engine.onEvent({
    type: 'result',
    mode: 'repair',
    scanned: 80,
    hits: 5,
    fixed: 3,
    failed: [],
    remaining: 0,
    snapshotPath: 'C:\\fake\\data\\snapshots\\snapshot-1.json',
    restorePath: 'C:\\fake\\data\\snapshots\\restore-1.ps1',
  })
  engine.resolveDone({ code: 0, stderr: '' })
  const settled = await waitTerminal(manager, started.jobId)
  assert.equal(settled.status, 'succeeded')
  assert.equal(settled.hits, 5)
  assert.equal(settled.fixed, 3)
  assert.equal(settled.total, 5)
  assert.equal(settled.items.length, 0)
  const snapshot = manager.snapshot(settled)
  assert.equal(snapshot.hits, 5)
  assert.equal(snapshot.fixed, 3)
  assert.equal(snapshot.total, 5)
  assert.deepEqual(snapshot.items, [])
  manager.dispose()
})

test('scan progress hits merge with streamed hit events and result overrides', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'scan', workspace: WORKSPACE, sessionId: 's1' })
  const job = manager.get(started.jobId)

  // quick mode: progress reports the full Low count (with null total) before
  // any explicit hit line is streamed.
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 100 })
  assert.equal(job.total, null)
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 200, hits: 3 })
  assert.equal(job.hits, 3)

  // only explicit Low objects are streamed as hit events, after the scan phase.
  engine.onEvent({ type: 'hit', path: 'C:\\fake\\workspace\\a.txt', kind: 'file', explicit: true })
  assert.equal(job.hits, 4)
  assert.equal(job.items.length, 1)

  // A stale/lower progress sample never rolls the merged count back.
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 240, hits: 1 })
  assert.equal(job.hits, 4)

  engine.onEvent({
    type: 'result',
    mode: 'scan',
    depth: 'quick',
    scanned: 250,
    hits: 3,
    explicitCount: 1,
    inheritedCount: 2,
    rootLabel: 'Low',
  })
  engine.resolveDone({ code: 2, stderr: '' })
  const settled = await waitTerminal(manager, started.jobId)
  assert.equal(settled.status, 'succeeded')
  // The result event is authoritative: the transient merge over-count is dropped.
  assert.equal(settled.hits, 3)
  assert.equal(settled.explicitCount, 1)
  assert.equal(settled.inheritedCount, 2)
  assert.equal(settled.items.length, 1)
  assert.equal(settled.total, null)
  manager.dispose()
})

test('progress with a missing or null total keeps the previously known total', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = manager.get(started.jobId)
  engine.onEvent({ type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true })

  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 10 })
  assert.equal(job.total, null)
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 20, total: null })
  assert.equal(job.total, null)

  engine.onEvent({ type: 'progress', phase: 'repair', scanned: 1, total: 4, hits: 4, fixed: 1 })
  assert.equal(job.total, 4)
  // null total (verify phase transition) must not clear the known total.
  engine.onEvent({ type: 'progress', phase: 'repair', scanned: 2, total: null, hits: 4, fixed: 2 })
  assert.equal(job.total, 4)
  // absent total must not clear it either.
  engine.onEvent({ type: 'progress', phase: 'verify', scanned: 3 })
  assert.equal(job.total, 4)

  engine.onEvent({ type: 'result', mode: 'repair', scanned: 20, hits: 4, fixed: 2, failed: [], remaining: 0 })
  engine.resolveDone({ code: 0, stderr: '' })
  const settled = await waitTerminal(manager, started.jobId)
  assert.equal(settled.status, 'succeeded')
  assert.equal(settled.total, 4)
  manager.dispose()
})

test('verify progress keeps the repair total and failedTotal overrides the capped list', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = manager.get(started.jobId)
  engine.onEvent({ type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true })

  engine.onEvent({ type: 'progress', phase: 'repair', scanned: 1, total: 5, hits: 5, fixed: 1 })
  assert.equal(job.total, 5)
  // The verify phase total is the (small) failed-candidate count and must not
  // replace the hit-count total used by the progress bar / ETA.
  engine.onEvent({ type: 'progress', phase: 'verify', scanned: 1, total: 2, hits: 5, fixed: 4 })
  assert.equal(job.total, 5)

  // The engine caps result.failed at 1000 entries; failedTotal is authoritative.
  engine.onEvent({
    type: 'result',
    mode: 'repair',
    scanned: 5,
    hits: 5,
    fixed: 3,
    failed: [
      { path: 'C:\\fake\\workspace\\a.txt', message: 'x', output: '' },
      { path: 'C:\\fake\\workspace\\b.txt', message: 'y', output: '' },
    ],
    failedTotal: 114330,
    remaining: 2,
    daclRestoreFailures: 0,
  })
  engine.resolveDone({ code: 2, stderr: '' })
  const settled = await waitTerminal(manager, started.jobId)
  assert.equal(settled.status, 'failed')
  assert.equal(settled.total, 5)
  assert.equal(settled.failedCount, 114330)
  assert.equal(settled.failed.length, 2)
  manager.dispose()
})

test('result.errors are merged into host errors without streamed raw events', async () => {
  const engine = controllableEngine()
  const manager = makeManager(engine.run)
  const started = manager.start({ action: 'repair', workspace: WORKSPACE, sessionId: 's1' })
  const job = manager.get(started.jobId)
  engine.onEvent({ type: 'env', user: 'tester', integrity: 'Medium', canWriteLabel: true })
  engine.onEvent({ type: 'progress', phase: 'enumerate', scanned: 3 })

  // Repair no longer streams scan-time error events; the result carries them.
  engine.onEvent({
    type: 'result',
    mode: 'repair',
    scanned: 3,
    hits: 3,
    fixed: 3,
    failed: [],
    failedTotal: 0,
    remaining: 0,
    daclRestoreFailures: 0,
    errors: [
      { path: 'C:\\fake\\workspace\\locked.txt', message: 'Access is denied.' },
      { path: 'C:\\fake\\workspace\\locked.txt', message: 'Access is denied.' },
    ],
  })
  engine.resolveDone({ code: 0, stderr: '' })
  const settled = await waitTerminal(manager, started.jobId)
  assert.equal(settled.status, 'succeeded')
  // De-duplicated by path + message; the count stays authoritative.
  assert.equal(settled.errors.length, 1)
  assert.equal(settled.errorCount, 1)
  assert.equal(settled.errors[0].path, 'C:\\fake\\workspace\\locked.txt')
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
