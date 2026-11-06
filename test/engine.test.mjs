import assert from 'node:assert/strict'
import test from 'node:test'
import { engineArgs, parseEngineLine } from '../lib/engine.js'

test('parseEngineLine accepts protocol events', () => {
  assert.deepEqual(parseEngineLine('{"type":"progress","scanned":3}'), { type: 'progress', scanned: 3 })
  assert.deepEqual(parseEngineLine('  {"type":"hit","path":"C:\\\\a"}  '), { type: 'hit', path: 'C:\\a' })
})

test('parseEngineLine ignores blank, invalid and typeless lines', () => {
  assert.equal(parseEngineLine(''), null)
  assert.equal(parseEngineLine('   '), null)
  assert.equal(parseEngineLine('not json'), null)
  assert.equal(parseEngineLine('{"scanned":3}'), null)
  assert.equal(parseEngineLine('{"type":5}'), null)
  assert.equal(parseEngineLine(null), null)
})

test('engineArgs builds a hidden, non-interactive PowerShell invocation', () => {
  const args = engineArgs({
    enginePath: 'C:\\pkg\\engine\\integrity.ps1',
    mode: 'Scan',
    root: 'C:\\work\\space',
    skipDirs: 'node_modules,.git',
    dataDir: 'C:\\Users\\tester\\.dsh\\low-integrity-check',
  })
  assert.deepEqual(args.slice(0, 9), [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\pkg\\engine\\integrity.ps1',
    '-Mode',
  ])
  assert.equal(args[9], 'Scan')
  assert.equal(args.includes('-Root'), true)
  assert.equal(args.includes('C:\\work\\space'), true)
  assert.equal(args.includes('-DataDir'), true)
  assert.equal(args[args.length - 1], '-Json')
})

test('engineArgs omits optional values but always ends with -Json', () => {
  const args = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Env' })
  assert.deepEqual(args.slice(-2), ['Env', '-Json'])
  assert.equal(args.includes('-Root'), false)
  assert.equal(args.includes('-SkipDirs'), false)
})
