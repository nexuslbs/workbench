// TEST DOUBLE of the `web@1` seam and its `node:http` provider.
//
// The REAL Definition (`definitions/web.ts`) and the provider (`plugins/web-impl`)
// now live in the EXTERNAL plugins repository (`nexuslbs/workbench-plugins`), so
// the core no longer ships them and its tests must not import them. The core's
// OWN web surface (the tool routes registered by `tool-routes.ts`) still has to be
// exercised over a real listener, so this file provides the minimal seam +
// listener those tests need: route matching (exact and `:param`), request body
// reading, JSON responses and the 404.
//
// It is a TEST DOUBLE, not a provider and not a product feature: the production
// provider is covered by the plugins repository tests and by the CI image run.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** The capability id of the seam (the Definition in the plugins repo uses the same). */
export const WEB = 'web'

/** Request body cap of the double (the provider caps it the same way). */
export const MAX_BODY_BYTES = 1024 * 1024

/** A seam request, as the double hands it to a handler. */
export interface WebRequest {
  method: string
  path: string
  params?: Record<string, string>
  query: URLSearchParams
  headers: Record<string, string | string[] | undefined>
  readText(): Promise<string>
  readJson<T = unknown>(): Promise<T>
}

/** What a handler answers. */
export interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

/** A route registration. */
export interface WebRouteSpec {
  method: string
  path: string
  handler: (request: WebRequest) => WebResponse | undefined | void | Promise<WebResponse | undefined | void>
  description?: string
}

/**
 * The seam: a route/asset/page registry, exactly the surface consumers use.
 *
 * Deliberately takes NO cordis context: the double is not a cordis `Service`
 * and the core registers nothing through it. Registration and disposal belong
 * to the PRODUCTION provider plugin (`web-impl` in the plugins repository);
 * this double only has to reproduce routing and body reading for the tests.
 */
export class Web {
  private readonly routeSpecs: WebRouteSpec[] = []
  private readonly assetSpecs: { path: string; file?: string; body?: string }[] = []
  private readonly pageSpecs: { id: string; title: string; path: string; module: string; plugin?: string }[] = []
  private disposers: (() => void)[] = []

  route(spec: WebRouteSpec): () => void {
    this.routeSpecs.push(spec)
    const dispose = (): void => {
      const index = this.routeSpecs.indexOf(spec)
      if (index >= 0) this.routeSpecs.splice(index, 1)
    }
    this.disposers.push(dispose)
    return dispose
  }

  asset(spec: { path: string; file?: string; body?: string }): () => void {
    this.assetSpecs.push(spec)
    return () => {
      const index = this.assetSpecs.indexOf(spec)
      if (index >= 0) this.assetSpecs.splice(index, 1)
    }
  }

  page(spec: { id: string; title: string; path: string; module: string; plugin?: string }): () => void {
    this.pageSpecs.push(spec)
    return () => {
      const index = this.pageSpecs.indexOf(spec)
      if (index >= 0) this.pageSpecs.splice(index, 1)
    }
  }

  routes(): WebRouteSpec[] {
    return [...this.routeSpecs]
  }

  pages(): { id: string; title: string; path: string; module: string; plugin?: string }[] {
    return [...this.pageSpecs]
  }

  assets(): { path: string; file?: string; body?: string }[] {
    return [...this.assetSpecs]
  }

  /** Disposes every registration this seam made (unload semantics). */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /** Matches one request against the registered routes and runs its handler. */
  async dispatch(method: string, pathname: string, request: WebRequest): Promise<WebResponse | undefined> {
    const parts = pathname.split('/')
    for (const spec of this.routeSpecs) {
      if (spec.method.toUpperCase() !== method.toUpperCase()) continue
      const specParts = spec.path.split('/')
      if (specParts.length !== parts.length) continue
      const params: Record<string, string> = {}
      const matched = specParts.every((segment, index) => {
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[index] ?? '')
          return true
        }
        return segment === parts[index]
      })
      if (!matched) continue
      const withParams = Object.keys(params).length > 0 ? { ...request, params } : request
      const answer = await spec.handler(withParams)
      if (answer) return answer
    }
    return undefined
  }
}

/** The listener the double starts. */
export interface FixtureWebServer {
  url: string
  port: number
  close(): Promise<void>
}

/** Starts a `node:http` server that dispatches to `web` (JSON 404 when nothing answers). */
export async function createWebServer(web: Web, options: { host?: string; port?: number } = {}): Promise<FixtureWebServer> {
  const server = http.createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
    let body: Promise<string> | undefined
    const readText = (): Promise<string> => {
      body ??= new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            reject(new Error('request body too large'))
            incoming.destroy()
            return
          }
          chunks.push(chunk)
        })
        incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        incoming.on('error', reject)
      })
      return body
    }
    const request: WebRequest = {
      method: incoming.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: incoming.headers,
      readText,
      readJson: async <T = unknown>(): Promise<T> => JSON.parse(await readText()) as T,
    }
    void web
      .dispatch(request.method, request.path, request)
      .then((answer) => {
        if (!answer) {
          outgoing.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          outgoing.end(JSON.stringify({ status: 'not found', path: request.path }) + '\n')
          return
        }
        outgoing.writeHead(answer.status ?? 200, {
          'content-type': answer.contentType ?? 'application/json; charset=utf-8',
          ...(answer.headers ?? {}),
        })
        outgoing.end(answer.body ?? '')
      })
      .catch((error: unknown) => {
        outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        outgoing.end(JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : String(error) }) + '\n')
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
