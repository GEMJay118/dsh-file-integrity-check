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
 * Resolve DSH's bundled `@deepseek-ai/schemastery` without adding a package
 * dependency (C3). The plugin is loaded from a `link:` directory, so a bare
 * `import` from this module resolves against the repository, not the profile;
 * anchoring `createRequire` on the DSH entry script finds the profile runtime.
 * Any failure must be non-fatal: without a schema the plugin still loads.
 * @returns {Promise<object|null>}
 */
async function resolveSchemastery() {
  try {
    const { createRequire } = await import('node:module')
    const anchor = typeof process.argv[1] === 'string' && process.argv[1] !== '' ? process.argv[1] : process.execPath
    const factory = createRequire(anchor)('@deepseek-ai/schemastery')
    if (factory !== null && factory !== undefined && typeof factory.object === 'function') return factory
  } catch {
    /* fall through to the module resolution below */
  }
  try {
    const specifier = '@deepseek-ai/schemastery'
    const resolved = await import(specifier)
    const factory = resolved?.default ?? resolved?.Schema ?? null
    return factory !== null && factory !== undefined && typeof factory.object === 'function' ? factory : null
  } catch {
    return null
  }
}

const SchemaFactory = await resolveSchemastery()

/**
 * Build the Config schema, never throwing: a missing or older schema factory
 * must not stop the plugin from loading (loading is more important than the
 * optional settings fields).
 * @param {object} factory resolved schemastery factory
 * @returns {object|undefined}
 */
function createConfigSchema(factory) {
  try {
    // `.volatile()` is a Loader extension and may be missing on an older or
    // different schema factory; without it the field still works as plain
    // config (the panel/settings save then needs a plugin reload to apply).
    const volatile = (schema) => (schema !== null && schema !== undefined && typeof schema.volatile === 'function' ? schema.volatile() : schema)
    const dataDirBase = factory.string().default('')
    let retentionBase = factory.number().default(30)
    if (typeof retentionBase.min === 'function') retentionBase = retentionBase.min(1)
    if (typeof retentionBase.max === 'function') retentionBase = retentionBase.max(3650)
    if (typeof retentionBase.step === 'function') retentionBase = retentionBase.step(1)
    return factory.object({
      // '' means the default `%DSH_HOME%\low-integrity-check`.
      dataDir: volatile(dataDirBase),
      // Artifact retention in days; the Host still validates 1..3650 itself.
      retentionDays: volatile(retentionBase),
    })
  } catch {
    return undefined
  }
}

/**
 * Plugin Config: an optional product directory plus an artifact retention.
 * `dataDir === ''` means the default `%DSH_HOME%\low-integrity-check`;
 * `retentionDays` defaults to 30. `volatile` lets the Host persist changes
 * through `configEditor` without restarting the plugin, and the Host re-reads
 * both refs at the start of every job / cleanup. `undefined` when the schema
 * factory is unavailable (the Host then falls back to plain raw config).
 */
export const Config = SchemaFactory === null ? undefined : createConfigSchema(SchemaFactory)

/**
 * Activate the Host half.
 * @param {object} ctx Cordis context
 * @param {object} [config] resolved plugin config
 */
export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}
