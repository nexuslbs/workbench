/**
 * Registration attribution.
 *
 * Several core services attribute what a plugin registers to that plugin (the
 * command registry does it by diffing the name set, see
 * `CommandRegistry.attribute`). The web seam attributes a route/asset/page to
 * the plugin that registered it, and it must not trust a caller supplied name.
 *
 * The loader marks the plugin whose `apply` is running around `ctx.plugin(...)`
 * (plugin loads are sequential and awaited, so a single marker is exact), and
 * every registration made while it is set is attributed to that plugin. This
 * module exists on its own so the loader and the seam share one marker without
 * the seam depending on the loader.
 */

let applying: string | undefined

/** Marks the plugin whose `apply` is running; returns the restore function. */
export function markApplying(plugin: string): () => void {
  const previous = applying
  applying = plugin
  return () => {
    applying = previous
  }
}

/** The plugin registrations are currently attributed to (`core` when none). */
export function applyingPlugin(): string {
  return applying ?? 'core'
}
