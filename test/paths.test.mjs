import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BROAD_HOME_DIRS,
  countLiveAgents,
  dshHomeDir,
  evaluateRootSafety,
  isInside,
  pathKey,
  realpathOrNull,
  resolveWorkspace,
  samePath,
} from '../lib/paths.js'

const HOME = 'C:\\Users\\tester'
const DSH_HOME = 'C:\\Users\\tester\\.dsh'
const INSTALL = 'C:\\Program Files\\DSH'

function evaluate(target, extra = {}) {
  return evaluateRootSafety(target, {
    home: HOME,
    dshHome: DSH_HOME,
    installRoots: [INSTALL],
    ...extra,
  })
}

test('pathKey normalizes separators and case on Windows', () => {
  assert.equal(pathKey('C:\\Users\\Tester\\Work\\'), pathKey('c:/users/tester/work'))
})

test('samePath and isInside are segment-safe', () => {
  assert.equal(samePath('C:\\Work\\App', 'c:\\work\\app\\'), true)
  assert.equal(isInside('C:\\Work\\App\\src', 'C:\\Work\\App'), true)
  assert.equal(isInside('C:\\Work\\Application', 'C:\\Work\\App'), false)
  assert.equal(isInside('C:\\Work\\App', 'C:\\Work\\App'), false)
})

test('rejects empty and relative targets', () => {
  assert.equal(evaluate('').ok, false)
  assert.equal(evaluate('relative\\folder').ok, false)
})

test('rejects drive roots', () => {
  assert.equal(evaluate('C:\\').ok, false)
  assert.equal(evaluate('D:').ok, false)
})

test('rejects user home and DSH data home', () => {
  assert.equal(evaluate(HOME).ok, false)
  assert.equal(evaluate(DSH_HOME).ok, false)
  assert.equal(evaluate('C:\\Users\\tester\\.dsh\\sessions').ok, false)
})

test('rejects the DSH installation directory', () => {
  assert.equal(evaluate(INSTALL).ok, false)
  assert.equal(evaluate('C:\\Program Files\\DSH\\resources').ok, false)
})

test('rejects broad personal folders under the home directory', () => {
  for (const name of ['Desktop', 'Documents', 'Downloads', 'OneDrive']) {
    assert.equal(evaluate(path.join(HOME, name)).ok, false, name)
  }
  assert.equal(BROAD_HOME_DIRS.includes('desktop'), true)
  // A normal project inside Documents is a legitimate workspace.
  assert.equal(evaluate('C:\\Users\\tester\\Documents\\project').ok, true)
})

test('requires the canonical path to be a registered workspace', () => {
  assert.equal(evaluate('C:\\Work\\Project', { registryPaths: ['C:\\Work\\Project'] }).ok, true)
  assert.equal(evaluate('C:\\Work\\Other', { registryPaths: ['C:\\Work\\Project'] }).ok, false)
})

test('rejects when no registry path matches', () => {
  assert.equal(evaluate('C:\\Work\\Project', { registryPaths: [] }).ok, true)
})

test('resolveWorkspace finds a workspace by session id and canonicalizes it', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-paths-'))
  try {
    const registry = {
      list: () => [{ id: 'ws-1', path: tempDir, title: 'Temp', sessionIds: ['session-1'] }],
      resolveByPath: async () => undefined,
    }
    const result = await resolveWorkspace({ sessionId: 'session-1', registry })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.workspace.id, 'ws-1')
    assert.equal(path.resolve(result.workspace.path), path.resolve((await fs.realpath(tempDir)) || tempDir))
    assert.deepEqual(result.sessionIds, ['session-1'])
    assert.equal(result.sessionCount, 1)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('resolveWorkspace falls back to resolveByPath for the hint', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fi-paths-'))
  try {
    const registry = {
      list: () => [{ id: 'ws-1', path: tempDir, title: 'Temp', sessionIds: [] }],
      resolveByPath: async (hint) => (path.resolve(hint) === path.resolve(tempDir) ? { id: 'ws-1', path: tempDir, title: 'Temp', sessionIds: [] } : undefined),
    }
    const result = await resolveWorkspace({ sessionId: 'unknown', registry, hintPath: tempDir })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.source, 'hint')
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('resolveWorkspace reports missing session, missing registry and missing directory', async () => {
  assert.equal((await resolveWorkspace({ sessionId: 'x', registry: undefined })).code, 'registry-unavailable')
  const empty = { list: () => [] }
  assert.equal((await resolveWorkspace({ sessionId: 'x', registry: empty })).code, 'workspace-not-found')
  const missingDir = path.join(os.tmpdir(), 'dsh-fi-does-not-exist-' + process.pid)
  const registry = { list: () => [{ id: 'w', path: missingDir, title: '', sessionIds: ['s'] }] }
  assert.equal((await resolveWorkspace({ sessionId: 's', registry })).code, 'path-missing')
})

test('realpathOrNull returns null for a missing target', async () => {
  assert.equal(await realpathOrNull(path.join(os.tmpdir(), 'dsh-fi-missing-' + process.pid)), null)
})

test('countLiveAgents intersects live agent ids with the workspace sessions', () => {
  const agents = { list: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  assert.equal(countLiveAgents(agents, ['a', 'c', 'z']), 2)
  assert.equal(countLiveAgents(undefined, ['a']), 0)
})

test('dshHomeDir honors DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\Custom\\DshHome'
  try {
    assert.equal(path.resolve(dshHomeDir()), path.resolve('C:\\Custom\\DshHome'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
