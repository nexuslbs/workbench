import { ToolRegistry, type ToolDefinition, type ToolInfo } from './tool-registry.ts'
import type { CommandDefinition, LoadedPlugin } from './types.ts'

/**
 * The workbench core service: holds the commands AND the tools plugins
 * registered, and the plugins that were loaded. Plugins only ever talk to the
 * core through this.
 *
 * Commands are the CLI-shaped capability (`workbench <command> [args...]`);
 * tools are the by-name invocation capability (a name plus a parameter schema,
 * invoked over HTTP, from the CLI or in process). Both live in one service
 * because `ctx.workbench` is the single contract a plugin sees; the tool half is
 * delegated to {@link ToolRegistry}, which holds the single dispatch.
 */
export class CommandRegistry {
  #commands = new Map<string, CommandDefinition>()
  #tools: ToolRegistry
  #plugins: LoadedPlugin[] = []
  #log: (message: string) => void

  constructor(log: (message: string) => void) {
    this.#log = log
    this.#tools = new ToolRegistry(log)
  }

  /** Registers a tool (name + parameter schema + handler); returns the disposer. */
  registerTool(def: Omit<ToolDefinition, 'plugin' | 'schema'>): () => void {
    return this.#tools.registerTool(def)
  }

  /** The registered tool names. */
  toolNames(): Set<string> {
    return this.#tools.toolNames()
  }

  /** Every registered tool with its parameter schema, sorted by name. */
  tools(): ToolInfo[] {
    return this.#tools.tools()
  }

  /** One registered tool definition, or undefined. */
  tool(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  /**
   * THE by-name dispatch: validate the params against the tool's schema, then
   * run its handler. Every caller (HTTP routes, the CLI, an in-process
   * consumer) goes through here.
   */
  executeTool(name: string, params?: unknown): Promise<unknown> {
    return this.#tools.execute(name, params)
  }

  registerCommand(def: Omit<CommandDefinition, 'plugin'>): () => void {
    const name = String(def.name ?? '').trim().replace(/\s+/g, ' ')
    if (!name) throw new Error('registerCommand: a command name is required')
    if (typeof def.run !== 'function') throw new Error(`registerCommand('${name}'): 'run' must be a function`)
    if (this.#commands.has(name)) throw new Error(`command '${name}' is already registered`)
    const entry: CommandDefinition = { ...def, name }
    this.#commands.set(name, entry)
    return () => {
      if (this.#commands.get(name) === entry) this.#commands.delete(name)
    }
  }

  /** Attributes commands registered since `known` to a plugin (called by the loader). */
  attribute(plugin: string, known: Set<string>): void {
    for (const [name, command] of this.#commands) {
      if (!known.has(name) && command.plugin === undefined) command.plugin = plugin
    }
  }

  commandNames(): Set<string> {
    return new Set(this.#commands.keys())
  }

  commands(): CommandDefinition[] {
    return [...this.#commands.values()]
  }

  resolve(argv: string[]): { command: CommandDefinition; args: string[] } | undefined {
    const words = argv.filter((word) => word.length > 0)
    for (let size = words.length; size > 0; size--) {
      const command = this.#commands.get(words.slice(0, size).join(' '))
      if (command) return { command, args: words.slice(size) }
    }
    return undefined
  }

  setPlugins(plugins: LoadedPlugin[]): void {
    this.#plugins = plugins
  }

  plugins(): LoadedPlugin[] {
    return this.#plugins
  }

  log(message: string): void {
    this.#log(message)
  }
}
