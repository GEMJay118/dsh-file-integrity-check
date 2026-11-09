import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { defaultDataDir, ensureWritable, isInside, validateDataDir } from '../lib/datadir.js'
import { createRuntime } from '../lib/runtime.js'
import { PREFIX } from '../lib/routes.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-datadir-'))
}

/** Minimal Cordis context: capture the registered HTTP handler and effect disposers. */
function fakeRuntimeCtx(existing = {}) {
  const registered = []
  const disposers = []
  return {
    ...existing,
    registered,
    logger: {},
    fiber: 'fiber' in existing ? existing.fiber : { entry: { id: 'dsh-file-integrity-check' } },
    get(name) {
      return typeof existing.get === 'function' ? existing.get(name) : undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    /** Dispose every registered effect (stops cleanup timers between tests). */
    disposeEffects() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* best effort */
        }
      }
    },
  }
}

/** Start the runtime handler on a loopback port. */
async function startRuntime(ctx, config) {
  createRuntime(ctx, config)
  const route = ctx.registered[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, PREFIX)
  const server = createServer(route.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: 'http://127.0.0.1:' + port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      if (typeof ctx.disposeEffects === 'function') ctx.disposeEffects()
    },
  }
}

async function callJson(base, pathname, options) {
  const response = await fetch(base + pathname, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json }
}

/** Isolate %DSH_HOME% for one test and restore it afterwards. */
async function withDshHome(run) {
  const original = process.env.DSH_HOME
  const base = await tempDir()
  process.env.DSH_HOME = base
  try {
    return await run(base)
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
    await fs.rm(base, { recursive: true, force: true })
  }
}

/** Validate against an isolated environment so real user dirs never matter. */
function isolatedOptions(bases) {
  return {
    home: path.join(bases, 'home'),
    dshHome: path.join(bases, 'dsh-home'),
    installRoots: [path.join(bases, 'install'), path.join(bases, 'install', 'resources')],
  }
}

test('defaultDataDir follows DSH_HOME and appends low-integrity-check', async () => {
  const base = await tempDir()
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = base
    assert.equal(defaultDataDir(), path.join(base, 'low-integrity-check'))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('an empty or blank value means the default directory', () => {
  assert.deepEqual(validateDataDir(''), { ok: true, path: '', isDefault: true })
  assert.deepEqual(validateDataDir('   '), { ok: true, path: '', isDefault: true })
})

test('non-string values are rejected as settings-invalid', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    const result = validateDataDir(value)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'settings-invalid')
  }
})

test('relative and drive-relative paths are rejected before resolution', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    for (const value of ['data', 'data\\sub', '.\\data', 'D:data', '\\rooted']) {
      const result = validateDataDir(value, options)
      assert.equal(result.ok, false, value)
      assert.equal(result.code, 'settings-invalid')
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('UNC and device paths are rejected', () => {
  for (const value of ['\\\\server\\share\\data', '//server/share/data', '\\\\?\\D:\\data']) {
    const result = validateDataDir(value)
    assert.equal(result.ok, false, value)
    assert.equal(result.code, 'settings-invalid')
    assert.match(result.message, /UNC|绝对路径/)
  }
})

test('drive roots are rejected', () => {
  for (const value of ['D:\\', 'D:/']) {
    const result = validateDataDir(value)
    assert.equal(result.ok, false, value)
    assert.match(result.message, /根目录/)
  }
})

test('the user home itself is rejected but a subdirectory is allowed', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    const home = options.home
    assert.equal(validateDataDir(home, options).ok, false)
    assert.equal(validateDataDir(home + path.sep, options).ok, false)
    const sub = path.join(home, 'integrity-artifacts')
    const allowed = validateDataDir(sub, options)
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(allowed.path, path.resolve(sub))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('the DSH data home and its sessions/profiles trees are rejected', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    for (const value of [
      options.dshHome,
      path.join(options.dshHome, 'sessions'),
      path.join(options.dshHome, 'sessions', 'abc'),
      path.join(options.dshHome, 'profiles'),
      path.join(options.dshHome, 'profiles', 'desktop'),
    ]) {
      const result = validateDataDir(value, options)
      assert.equal(result.ok, false, value)
      assert.equal(result.code, 'settings-invalid')
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('a dedicated folder inside the DSH data home is allowed', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    const own = path.join(options.dshHome, 'low-integrity-check')
    const result = validateDataDir(own, options)
    assert.equal(result.ok, true)
    assert.equal(result.isDefault, false)
    assert.equal(result.path, path.resolve(own))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('the DSH installation directory is rejected', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    for (const value of [
      path.join(base, 'install'),
      path.join(base, 'install', 'resources'),
      path.join(base, 'install', 'resources', 'app.asar'),
      path.join(base, 'install', 'sub'),
    ]) {
      const result = validateDataDir(value, options)
      assert.equal(result.ok, false, value)
      assert.match(result.message, /安装目录/)
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('an existing file is rejected while a missing directory is accepted', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    const file = path.join(base, 'not-a-folder.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const fileResult = validateDataDir(file, options)
    assert.equal(fileResult.ok, false)
    assert.match(fileResult.message, /不是文件夹/)

    const missing = path.join(base, 'nested', 'deep', 'data')
    const missingResult = validateDataDir(missing, options)
    assert.equal(missingResult.ok, true, JSON.stringify(missingResult))
    assert.equal(missingResult.path, path.resolve(missing))
    assert.equal(missingResult.isDefault, false)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('a normal existing temp directory is accepted and normalized', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    const target = path.join(base, 'artifacts')
    await fs.mkdir(target, { recursive: true })
    const result = validateDataDir(target + path.sep, options)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.path, path.resolve(target))
    assert.equal(result.isDefault, false)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('Windows-illegal characters and alternate data streams are rejected', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    for (const value of ['D:\\bad<name>', 'D:\\bad|name', 'D:\\data:stream', path.join(base, 'bad?name')]) {
      const result = validateDataDir(value, options)
      assert.equal(result.ok, false, value)
      assert.equal(result.code, 'settings-invalid')
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('parent segments are normalized away', async () => {
  const base = await tempDir()
  try {
    const options = isolatedOptions(base)
    const result = validateDataDir(path.join(base, 'one', '..', 'two'), options)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.path, path.resolve(base, 'two'))
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('isInside reports strict containment with case-insensitive Windows keys', async () => {
  const base = await tempDir()
  try {
    const sub = path.join(base, 'sub')
    const nested = path.join(sub, 'deep')
    assert.equal(isInside(base, sub), true)
    assert.equal(isInside(base, nested), true)
    assert.equal(isInside(sub, base), false)
    assert.equal(isInside(base, base), false)
    assert.equal(isInside(base, path.join(base + '-other', 'x')), false)
    assert.equal(isInside(sub, path.join(base, 'sibling')), false)
    if (process.platform === 'win32') assert.equal(isInside(base, sub.toUpperCase()), true)
    assert.equal(isInside('', sub), false)
    assert.equal(isInside(base, ''), false)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('ensureWritable creates the directory tree and removes its probe file', async () => {
  const base = await tempDir()
  try {
    const target = path.join(base, 'created', 'by', 'plugin')
    const result = await ensureWritable(target)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.path, path.resolve(target))
    const stat = await fs.stat(target)
    assert.equal(stat.isDirectory(), true)
    assert.deepEqual(await fs.readdir(target), [])
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('ensureWritable reports settings-unwritable for a file target', async () => {
  const base = await tempDir()
  try {
    const file = path.join(base, 'target.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const result = await ensureWritable(file)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'settings-unwritable')
    assert.match(result.message, /产物目录不可写/)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('ensureWritable rejects an empty path', async () => {
  for (const value of ['', '   ', null]) {
    const result = await ensureWritable(value)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'settings-unwritable')
  }
})

test('index.js loads without a resolvable schemastery and exposes a safe Config', async () => {
  const module = await import('../index.js')
  assert.equal(module.name, 'dsh-file-integrity-check')
  assert.ok(module.inject.includes('webServer'))
  assert.equal(typeof module.apply, 'function')
  // The schema factory is not guaranteed to resolve from the repository, but
  // the module must load either way; an unresolved factory exports undefined.
  assert.ok(module.Config === undefined || (module.Config !== null && typeof module.Config === 'object'))
})

test('the runtime re-reads a volatile dataDir and persists it through configEditor', async () => {
  await withDshHome(async (base) => {
    const expectedDefault = path.join(base, 'low-integrity-check')
    const target = path.join(base, 'artifacts')
    const state = { raw: '' }
    const volatileRef = { get: () => state.raw }
    const calls = []
    const configEditor = {
      async edit(entry, change) {
        calls.push(entry)
        const next = change({ keep: 'untouched', dataDir: state.raw }, {})
        assert.equal(next.keep, 'untouched')
        assert.equal(typeof next.dataDir, 'string')
        state.raw = next.dataDir
      },
    }
    const ctx = fakeRuntimeCtx({ get: (name) => (name === 'configEditor' ? configEditor : undefined) })
    const harness = await startRuntime(ctx, { dataDir: volatileRef })
    const headers = { 'content-type': 'application/json' }
    try {
      const initial = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(initial.status, 200)
      assert.deepEqual(initial.json, {
        ok: true,
        dataDir: expectedDefault,
        defaultDataDir: expectedDefault,
        isDefault: true,
        error: null,
        retentionDays: 30,
        retentionPresets: [3, 7, 15, 30],
        lastCleanup: null,
      })

      const saved = await callJson(harness.base, PREFIX + '/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ dataDir: target }),
      })
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.json, {
        ok: true,
        dataDir: path.resolve(target),
        defaultDataDir: expectedDefault,
        isDefault: false,
        retentionDays: 30,
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0], ctx.fiber.entry)
      assert.equal(state.raw, target)

      // The GET endpoint reads the live volatile ref, not a cached value.
      const live = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(live.json.dataDir, path.resolve(target))
      assert.equal(live.json.isDefault, false)

      // '' restores the default marker (an empty raw value).
      const reset = await callJson(harness.base, PREFIX + '/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ dataDir: '' }),
      })
      assert.equal(reset.status, 200)
      assert.equal(reset.json.isDefault, true)
      assert.equal(reset.json.dataDir, expectedDefault)
      assert.equal(state.raw, '')
    } finally {
      await harness.close()
    }
  })
})

test('a plain string config works when the Config schema is unavailable', async () => {
  await withDshHome(async (base) => {
    const expectedDefault = path.join(base, 'low-integrity-check')
    const target = path.join(base, 'plain-data')
    const ctx = fakeRuntimeCtx()
    const harness = await startRuntime(ctx, { dataDir: target })
    try {
      const read = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(read.status, 200)
      assert.equal(read.json.dataDir, path.resolve(target))
      assert.equal(read.json.defaultDataDir, expectedDefault)
      assert.equal(read.json.isDefault, false)
      assert.equal(read.json.error, null)
    } finally {
      await harness.close()
    }
  })
})

test('an invalid configured dataDir falls back to the default and reports the error', async () => {
  await withDshHome(async (base) => {
    const expectedDefault = path.join(base, 'low-integrity-check')
    const ctx = fakeRuntimeCtx()
    const harness = await startRuntime(ctx, { dataDir: 'relative-folder' })
    try {
      const read = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(read.status, 200)
      assert.equal(read.json.dataDir, expectedDefault)
      assert.equal(read.json.defaultDataDir, expectedDefault)
      assert.equal(read.json.isDefault, true)
      assert.match(read.json.error, /配置无效/)
    } finally {
      await harness.close()
    }
  })
})

test('the runtime reads and persists the volatile retentionDays together with dataDir', async () => {
  await withDshHome(async (base) => {
    const expectedDefault = path.join(base, 'low-integrity-check')
    const target = path.join(base, 'artifacts')
    const state = { dataDir: '', retentionDays: 30 }
    const edits = []
    const configEditor = {
      async edit(entry, change) {
        const next = change({ keep: 'untouched', dataDir: state.dataDir, retentionDays: state.retentionDays }, {})
        assert.equal(next.keep, 'untouched')
        edits.push(next)
        state.dataDir = next.dataDir
        state.retentionDays = next.retentionDays
      },
    }
    const ctx = fakeRuntimeCtx({ get: (name) => (name === 'configEditor' ? configEditor : undefined) })
    const config = {
      dataDir: { get: () => state.dataDir },
      retentionDays: { get: () => state.retentionDays },
    }
    const harness = await startRuntime(ctx, config)
    const headers = { 'content-type': 'application/json' }
    try {
      const initial = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(initial.status, 200)
      assert.equal(initial.json.retentionDays, 30)
      assert.equal(initial.json.dataDir, expectedDefault)

      const saveRetention = await callJson(harness.base, PREFIX + '/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ retentionDays: 7 }),
      })
      assert.equal(saveRetention.status, 200)
      assert.equal(saveRetention.json.retentionDays, 7)
      assert.equal(saveRetention.json.dataDir, expectedDefault)
      // One configEditor edit carries the merged patch.
      assert.deepEqual(edits[0], { keep: 'untouched', dataDir: '', retentionDays: 7 })

      const saveBoth = await callJson(harness.base, PREFIX + '/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ dataDir: target, retentionDays: 15 }),
      })
      assert.equal(saveBoth.status, 200)
      assert.equal(saveBoth.json.dataDir, path.resolve(target))
      assert.equal(saveBoth.json.retentionDays, 15)
      assert.equal(edits.length, 2)
      assert.equal(edits[1].dataDir, target)
      assert.equal(edits[1].retentionDays, 15)

      const live = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(live.json.retentionDays, 15)
      assert.equal(live.json.dataDir, path.resolve(target))
    } finally {
      await harness.close()
    }
  })
})

test('an invalid configured retentionDays falls back to 30 without breaking the runtime', async () => {
  await withDshHome(async (base) => {
    const expectedDefault = path.join(base, 'low-integrity-check')
    const ctx = fakeRuntimeCtx()
    const harness = await startRuntime(ctx, { retentionDays: { get: () => 9999 } })
    try {
      const read = await callJson(harness.base, PREFIX + '/settings')
      assert.equal(read.status, 200)
      assert.equal(read.json.retentionDays, 30)
      assert.equal(read.json.dataDir, expectedDefault)
    } finally {
      await harness.close()
    }
  })
})

test('saving is settings-unavailable without configEditor or a loader entry', async () => {
  await withDshHome(async (base) => {
    const target = path.join(base, 'wanted')
    const noEditor = fakeRuntimeCtx()
    const first = await startRuntime(noEditor, {})
    try {
      const response = await callJson(first.base, PREFIX + '/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataDir: target }),
      })
      assert.equal(response.status, 501)
      assert.equal(response.json.code, 'settings-unavailable')
    } finally {
      await first.close()
    }

    const editor = { async edit() {} }
    const noEntry = fakeRuntimeCtx({ get: () => editor, fiber: undefined })
    const second = await startRuntime(noEntry, {})
    try {
      const response = await callJson(second.base, PREFIX + '/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataDir: target }),
      })
      assert.equal(response.status, 501)
      assert.equal(response.json.code, 'settings-unavailable')
    } finally {
      await second.close()
    }
  })
})

