// Core test plugin: proves the plugin contract without touching core internals.
// It only uses the service the core provides (`ctx.workbench`).
import type { WorkbenchContext } from '../../src/types.ts'

export const name = 'hello-world'

export interface Config {
  message?: string
}

export function apply(ctx: WorkbenchContext, config: Config = {}): void {
  const message = config.message ?? 'Hello World'
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'hello world',
      description: 'prints the core greeting',
      run: () => message,
    }),
  )
}

export default { name, inject: ['workbench'], apply }
