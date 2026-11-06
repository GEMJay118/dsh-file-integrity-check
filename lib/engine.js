/**
 * Spawn the integrity engine in a hidden, non-DSH PowerShell process and
 * parse its JSON Lines protocol.
 * @module dsh-low-integrity-check/lib/engine
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Cap for captured stderr text (bytes of decoded characters). */
export const MAX_STDERR = 64 * 1024

/** Locate Windows PowerShell 5.1; the engine must run outside DSH's own shell tooling. */
export function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(candidate)) return candidate
  return 'powershell.exe'
}

/**
 * Parse one protocol line.
 * @param {string} line
 * @returns {{type:string, [key:string]:unknown}|null} parsed event, or null for blank/invalid lines
 */
export function parseEngineLine(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** Build the argv for one engine run. */
export function engineArgs({ enginePath, mode, root, skipDirs, dataDir, icaclsPath }) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    enginePath,
    '-Mode',
    mode,
  ]
  if (typeof root === 'string' && root !== '') args.push('-Root', root)
  if (typeof skipDirs === 'string' && skipDirs !== '') args.push('-SkipDirs', skipDirs)
  if (typeof dataDir === 'string' && dataDir !== '') args.push('-DataDir', dataDir)
  if (typeof icaclsPath === 'string' && icaclsPath !== '') args.push('-IcaclsPath', icaclsPath)
  args.push('-Json')
  return args
}

/**
 * Start one engine process.
 *
 * @param {object} input
 * @param {string} input.enginePath absolute path to engine/integrity.ps1
 * @param {'Env'|'Scan'|'Repair'} input.mode
 * @param {string} [input.root]
 * @param {string} [input.skipDirs]
 * @param {string} [input.dataDir]
 * @param {string} [input.icaclsPath] test seam only
 * @param {(event:object)=>void} input.onEvent
 * @param {(line:string)=>void} [input.onStrayLine] decoded non-protocol stdout lines
 * @returns {{done: Promise<{code:number, error?:string, stderr:string}>, kill: ()=>void, getStderr: ()=>string, child: import('node:child_process').ChildProcess}}
 */
export function startEngine(input) {
  const {
    enginePath,
    mode,
    root,
    skipDirs,
    dataDir,
    icaclsPath,
    onEvent = () => {},
    onStrayLine = () => {},
  } = input
  const child = spawn(resolvePowerShell(), engineArgs({ enginePath, mode, root, skipDirs, dataDir, icaclsPath }), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let buffer = ''
  let stderr = ''
  let settled = false
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const event = parseEngineLine(line)
      if (event !== null) onEvent(event)
      else if (line.trim() !== '') onStrayLine(line)
      index = buffer.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < MAX_STDERR) stderr += chunk
  })

  const done = new Promise((resolve) => {
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolve({ code: -1, error: error instanceof Error ? error.message : String(error), stderr })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      resolve({ code: typeof code === 'number' ? code : -1, stderr })
    })
  })

  let killed = false
  function kill() {
    if (killed) return
    killed = true
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      const pid = child.pid
      if (pid === undefined || child.exitCode !== null) return
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref?.()
      } catch {
        /* best effort */
      }
    }, 1500)
    timer.unref?.()
  }

  return { child, done, kill, getStderr: () => stderr }
}
