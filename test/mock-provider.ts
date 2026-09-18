// In-memory credentials provider for tests: a tiny backend plus an optional
// failure, so tests can drive the SAME consumer call against a provider whose
// behaviour they fully control (provider id, values, errors, name list).
//
// Name lookup goes through the same candidate forms as the real providers
// (exact, ENV form, kebab form), so a mock behaves like an implementation of
// the contract rather than like a special case.
import { CREDENTIALS_VERSION, type CredentialProvider, type CredentialRef } from '../src/credentials/definition.ts'
import { candidateKeys, lookup } from '../src/credentials/providers/dotenv.ts'

export interface MockOptions {
  /** Reference (name or SCOPE/NAME) this provider fails on, to test error paths. */
  fail?: string
}

export function mockProvider(id: string, values: Record<string, string>, options: MockOptions = {}): CredentialProvider {
  return {
    id,
    version: CREDENTIALS_VERSION,
    describe: () => `in-memory map (${Object.keys(values).length} entry/entries)`,
    list: () => Object.keys(values),
    resolve: (ref: CredentialRef) => {
      const key = ref.scope ? `${ref.scope}/${ref.name}` : ref.name
      const fails =
        options.fail !== undefined &&
        (candidateKeys(ref.name).includes(options.fail) || key === options.fail)
      if (fails) throw new Error(`mock provider '${id}' failed for '${key}'`)
      if (ref.scope) return values[key]
      return lookup(values, ref.name)
    },
  }
}
