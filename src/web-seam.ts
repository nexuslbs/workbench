/**
 * The `web@1` seam as THE CORE uses it, declared STRUCTURALLY on purpose: the
 * Definition (`definitions/web.ts`) and every provider (the HTTP server plugin
 * `web-impl`) live in the EXTERNAL plugins repository
 * (`nexuslbs/workbench-plugins`), so the core must never import them. A provider
 * instance satisfies these shapes (method-style members are checked
 * bivariantly), which is the same trick the external consumer plugins use for
 * their own seams.
 *
 * This module is TYPE-ONLY: it declares no runtime value, owns no route and
 * binds no port. The core uses the seam for exactly TWO of its OWN routes, and
 * only when a provider plugin provided `ctx.web`:
 *
 *   GET/HEAD /health      the loader status the deployment healthchecks probe
 *                         (registered ONLY when the provider answers none)
 *   GET      /api/plugins the loader inventory
 *
 * Everything else - the listener, the pages, the assets, the by-name tool
 * routes (`/api/tools*`, provided by the external `tools-impl` plugin) - belongs
 * to plugins (operator rule 2026-09-19: the core is config load + source
 * discovery + plugin install + `${cred:...}` resolution, nothing else).
 */

/** One route a provider plugin's seam answers. */
export interface WebRouteSpec {
  method: string
  path: string
  handler: (request: WebRequest) => WebResponse | undefined | void | Promise<WebResponse | undefined | void>
  description?: string
}

/** The subset of a seam request the core routes read. */
export interface WebRequest {
  method: string
  path: string
  params?: Record<string, string>
  query?: URLSearchParams
  headers?: Record<string, string | string[] | undefined>
  readText(): Promise<string>
  readJson<T = unknown>(): Promise<T>
}

/** What a seam route answers. */
export interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

/** One route the seam already answers (read before the core registers its own). */
export interface WebRouteInfo {
  method: string
  path: string
}

/** The seam the core routes are registered on (a `web@1` provider plugin provides it). */
export interface WebSeam {
  route(spec: WebRouteSpec): () => void
  /**
   * The routes registered so far, when the provider plugin exposes them. The core
   * reads this before registering ITS OWN `/health`: a provider that already
   * answers that method+path OWNS it (the real `web-impl` registers the deployment
   * healthcheck, carrying the `web@1` contract and the live inventory), and the
   * seam REJECTS a duplicate method+path.
   */
  routes?(): WebRouteInfo[]
}
