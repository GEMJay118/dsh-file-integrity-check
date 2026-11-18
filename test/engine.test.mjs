import assert from 'node:assert/strict'
import test from 'node:test'
import { engineArgs, engineInvocation, parseEngineLine } from '../lib/engine.js'

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

test('engineArgs passes scan depth to the engine', () => {
  const quick = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Scan', scanDepth: 'quick' })
  assert.equal(quick[quick.indexOf('-ScanDepth') + 1], 'quick')
  assert.equal(quick[quick.length - 1], '-Json')
  const none = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Env' })
  assert.equal(none.includes('-ScanDepth'), false)
})

test('engineInvocation forwards scan depth to the real argv', () => {
  const invocation = engineInvocation({
    enginePath: 'C:\\e.ps1',
    mode: 'Scan',
    root: 'C:\\work\\space',
    scanDepth: 'deep',
  })
  assert.equal(typeof invocation.command, 'string')
  assert.equal(invocation.command.length > 0, true)
  assert.equal(invocation.args[invocation.args.indexOf('-ScanDepth') + 1], 'deep')
  assert.equal(invocation.args[invocation.args.length - 1], '-Json')
  const quick = engineInvocation({ enginePath: 'C:\\e.ps1', mode: 'Scan', scanDepth: 'quick' })
  assert.equal(quick.args[quick.args.indexOf('-ScanDepth') + 1], 'quick')
})

test('engineArgs omits optional values but always ends with -Json', () => {
  const args = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Env' })
  assert.deepEqual(args.slice(-2), ['Env', '-Json'])
  assert.equal(args.includes('-Root'), false)
  assert.equal(args.includes('-SkipDirs'), false)
})

test('engineArgs builds a read-only Preview invocation', () => {
  const args = engineArgs({
    enginePath: 'C:\\pkg\\engine\\integrity.ps1',
    mode: 'Preview',
    root: 'C:\\work\\space',
    skipDirs: 'node_modules,.git',
    dataDir: 'C:\\Users\\tester\\.dsh\\low-integrity-check',
  })
  assert.equal(args[args.indexOf('-Mode') + 1], 'Preview')
  assert.equal(args[args.indexOf('-Root') + 1], 'C:\\work\\space')
  assert.equal(args[args.indexOf('-SkipDirs') + 1], 'node_modules,.git')
  assert.equal(args[args.indexOf('-DataDir') + 1], 'C:\\Users\\tester\\.dsh\\low-integrity-check')
  assert.equal(args.includes('-ScanDepth'), false)
  assert.equal(args[args.length - 1], '-Json')
})

test('engineArgs never forwards scan depth for the Preview mode', () => {
  const preview = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Preview', root: 'C:\\work', scanDepth: 'deep' })
  assert.equal(preview[preview.indexOf('-Mode') + 1], 'Preview')
  assert.equal(preview.includes('-ScanDepth'), false)
  assert.equal(preview[preview.length - 1], '-Json')
  // Scan keeps forwarding it (K8).
  const scan = engineArgs({ enginePath: 'C:\\e.ps1', mode: 'Scan', scanDepth: 'deep' })
  assert.equal(scan[scan.indexOf('-ScanDepth') + 1], 'deep')
})

test('engineInvocation resolves the Preview argv with root, skip dirs and data dir', () => {
  const invocation = engineInvocation({
    enginePath: 'C:\\e.ps1',
    mode: 'Preview',
    root: 'C:\\work\\space',
    skipDirs: 'node_modules',
    dataDir: 'C:\\fake\\data',
  })
  assert.equal(typeof invocation.command, 'string')
  assert.equal(invocation.command.length > 0, true)
  assert.equal(invocation.args[invocation.args.indexOf('-Mode') + 1], 'Preview')
  assert.equal(invocation.args[invocation.args.indexOf('-Root') + 1], 'C:\\work\\space')
  assert.equal(invocation.args[invocation.args.indexOf('-SkipDirs') + 1], 'node_modules')
  assert.equal(invocation.args[invocation.args.indexOf('-DataDir') + 1], 'C:\\fake\\data')
  assert.equal(invocation.args.includes('-ScanDepth'), false)
  assert.equal(invocation.args[invocation.args.length - 1], '-Json')
})
