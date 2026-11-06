/**
 * Host half of the DSH low-integrity-check plugin.
 *
 * Registers a same-origin HTTP route under `/dsh-low-integrity-check`.
 * The browser half (client.js) drives the right-sidebar panel.
 * @module dsh-low-integrity-check
 */
import { createRuntime } from './lib/runtime.js'

/** Cordis plugin name. */
export const name = 'dsh-low-integrity-check'

/** Hard dependencies: the route carrier only. */
export const inject = ['webServer']

/**
 * Activate the Host half.
 * @param {object} ctx Cordis context
 */
export function apply(ctx) {
  createRuntime(ctx)
}
