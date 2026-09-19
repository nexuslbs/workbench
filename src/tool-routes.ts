/**
 * Tools capability - HTTP seam: the by-name invocation surface.
 *
 * A consumer plugin registers a tool (see `./definition.ts`); this module puts
 * the registered tools on the web seam so ANY caller - an operator with curl,
 * another service, the shipped omniagent `workbench` MCP plugin - can invoke one
 * by name:
 *
 *   GET  /api/tools               the tool list (name, description, plugin,
 *                                 parameter schema) - discovery
 *   GET  /api/tools/<name>        one descriptor
 *   POST /api/tools/<name>        invoke `<name>`, the PARAMETERS are the JSON body
 *   POST /api/tools               alias: body `{ "tool": ..., "params": {...} }`
 *   POST /api/tool/call           the same alias, the path the shipped omniagent
 *                                 consumer posts to (`{"tool","params"}`)
 *
 * The name in a path is a WHOLE, percent-encoded path segment
 * (`/api/tools/hello%20greet` -> the tool named `hello greet`); a tool name
 * containing `/` is only reachable through the alias bodies. Every invocation
 * route ends in the SAME {@link ToolSource.executeTool} call (one dispatch, one
 * validation path), so the canonical route, the alias and the CLI cannot drift.
 *
 * Status contract (documented in `docs/PLUGIN-CONTRACT.md`):
 *   200 the tool ran; body `{ status: 'ok', tool, result }`
 *   400 the body/params do not satisfy the schema; body carries the readable
 *       `error.violations` list (never a silent coercion, never a 500)
 *   404 the tool is unknown or was unloaded
 *   500 the handler itself threw; the process keeps serving
 *
 * The module registers nothing at import time: {@link registerToolRoutes} wires
 * the routes on a `Web` service and returns their disposer, exactly like any
 * other consumer. It adds no product feature to the core.
 */
import type { Web, WebRequest, WebResponse } from './web/definition.ts'
import { TOOLS_CONTRACT, ToolArgsError, ToolUnknownError, type ToolInfo } from './tool-registry.ts'

/** The capability this module serves: the registry with its single dispatch. */
export interface ToolSource {
  /** Every registered tool with its compiled parameter schema. */
  tools(): ToolInfo[]
  /** One registered tool, or undefined (the `GET /api/tools/<name>` lookup). */
  tool?(name: string): { name: string; description?: string } | undefined
  /**
   * THE dispatch: resolve by name, validate the params, then run the handler.
   * Throws {@link ToolUnknownError} / {@link ToolArgsError} before the handler.
   */
  executeTool(name: string, params?: unknown): Promise<unknown>
}

/** A JSON response (every route of this module answers JSON). */
function json(status: number, payload: unknown): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(payload, null, 2)}\n` }
}

/** Readable text of anything a handler threw. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** A structured tool error body (`status: 'error'`), the only error shape here. */
function errorBody(kind: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { status: 'error', error: { kind, message, ...extra } }
}

/**
 * Read the request body as JSON. An EMPTY body is `undefined` (the dispatcher
 * then takes `{}`), so a parameterless tool can be invoked with no body at all.
 */
async function readJsonBody(request: WebRequest): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let text: string
  try {
    text = await request.readText()
  } catch (error) {
    return { ok: false, message: `could not read the request body: ${messageOf(error)}` }
  }
  if (text.trim().length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, message: `request body must be valid JSON: ${messageOf(error)}` }
  }
}

/** The tool name of a path parameter (decoded by the provider already). */
function toolNameOf(request: WebRequest): string {
  return request.params?.name ?? ''
}

/**
 * THE invocation: the one place a tool call is executed and its outcome mapped
 * to a status. The path routes and the alias routes all call exactly this.
 */
async function invoke(source: ToolSource, tool: string, params: unknown): Promise<WebResponse> {
  try {
    const result = await source.executeTool(tool, params)
    return json(200, { status: 'ok', tool, result })
  } catch (error) {
    if (error instanceof ToolUnknownError) {
      return json(404, errorBody('unknown-tool', `unknown tool '${error.tool}'`, { tool: error.tool }))
    }
    if (error instanceof ToolArgsError) {
      return json(400, errorBody('invalid-params', error.message, { tool: error.tool, violations: error.violations }))
    }
    return json(500, errorBody('tool-failed', messageOf(error), { tool }))
  }
}

/** The `{ tool, params }` body of the alias routes (canonical + shipped path). */
async function invokeAlias(source: ToolSource, request: WebRequest): Promise<WebResponse> {
  const body = await readJsonBody(request)
  if (!body.ok) return json(400, errorBody('bad-request', body.message))
  if (body.value === undefined) {
    return json(400, errorBody('bad-request', 'the request body must be a JSON object like {"tool":"<name>","params":{...}}'))
  }
  if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
    return json(400, errorBody('bad-request', 'the request body must be a JSON object like {"tool":"<name>","params":{...}}'))
  }
  const { tool, params } = body.value as { tool?: unknown; params?: unknown }
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    return json(400, errorBody('bad-request', 'the request body needs a non-empty "tool" name'))
  }
  return invoke(source, tool, params)
}

/** The `GET /api/tools` payload. */
function listPayload(source: ToolSource): unknown {
  const tools = source.tools()
  return { status: 'ok', contract: TOOLS_CONTRACT, count: tools.length, tools }
}

/**
 * Registers the tool routes on the web seam and returns their disposer. The
 * composition root (`../kernel.ts`) calls this once at boot; a plugin that
 * wanted to serve tools itself could call it too. Nothing here is a product
 * feature: the tools are the plugins'.
 */
export function registerToolRoutes(web: Web, source: ToolSource): () => void {
  const disposers: Array<() => void> = [
    web.route({
      method: 'GET',
      path: '/api/tools',
      description: 'list the registered tools with their parameter schemas',
      handler: () => json(200, listPayload(source)),
    }),
    web.route({
      method: 'GET',
      path: '/api/tools/:name',
      description: 'one registered tool descriptor',
      handler: (request) => {
        const name = toolNameOf(request)
        const tool = source.tools().find((entry) => entry.name === name)
        if (tool === undefined) return json(404, errorBody('unknown-tool', `unknown tool '${name}'`, { tool: name }))
        return json(200, { status: 'ok', tool })
      },
    }),
    web.route({
      method: 'POST',
      path: '/api/tools/:name',
      description: 'invoke a tool by name, the parameters are the JSON body',
      handler: async (request) => {
        const body = await readJsonBody(request)
        if (!body.ok) return json(400, errorBody('bad-request', body.message))
        return invoke(source, toolNameOf(request), body.value)
      },
    }),
    web.route({
      method: 'POST',
      path: '/api/tools',
      description: 'invoke a tool by name, body {"tool","params"}',
      handler: (request) => invokeAlias(source, request),
    }),
    web.route({
      method: 'POST',
      path: '/api/tool/call',
      description: 'invoke a tool by name, body {"tool","params"} (omniagent consumer path)',
      handler: (request) => invokeAlias(source, request),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
