/**
 * Config seam - the READ/EDIT path for the ACTIVE config file.
 *
 * Settings / Plugin Settings consume it (through `ctx.workbench.config()`), and
 * the host uses it for the persistence of its own mutations (enable / disable /
 * install / uninstall). Two rules are absolute here:
 *
 *   1. values are returned UNEXPANDED: `${env:VAR}` and `${cred:NAME}` stay
 *      visible BY NAME, so a secret reference can be shown and edited without a
 *      value ever crossing this seam;
 *   2. a write is atomic (temp file + rename) and is validated (the new text is
 *      parsed back) BEFORE the file is replaced, so a bad edit can never leave a
 *      broken config behind.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, parseDocument, isSeq } from 'yaml'
import { configFormat } from './config.ts'
import type { ConfigPatch, RawConfigView } from './types.ts'

/** True when `file` is a regular file (an inline config is not editable). */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Renders a patch path for messages (`sources[0].id`). */
export function renderConfigPath(parts: (string | number)[]): string {
  return parts
    .map((part, index) => (typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`))
    .join('')
}

/** Reads the active config file AS WRITTEN: text and parsed value, unexpanded. */
export function readRawConfig(file: string): RawConfigView {
  const resolved = path.resolve(file)
  const format = configFormat(resolved)
  if (!isFile(resolved)) throw new Error(`config ${resolved}: not a file (an inline config cannot be viewed or edited)`)
  const text = fs.readFileSync(resolved, 'utf8')
  const value: unknown = format === 'json' ? JSON.parse(text) : parseYaml(text)
  return { file: resolved, writable: true, text, value }
}

/** Applies one patch to a plain JSON-ish value (the JSON config path). */
function applyPatchValue(root: unknown, patch: ConfigPatch): void {
  if (!Array.isArray(patch.path) || patch.path.length === 0) throw new Error('config patch: an empty path is not allowed')
  const body = patch.path.slice(0, -1)
  const last = patch.path[patch.path.length - 1] as string | number
  let parent: unknown = root
  for (const key of body) {
    if (parent === null || typeof parent !== 'object') {
      throw new Error(`config patch: path '${renderConfigPath(patch.path)}' does not resolve`)
    }
    const container = parent as Record<string | number, unknown>
    if (container[key] === undefined || container[key] === null) container[key] = typeof key === 'number' ? [] : {}
    parent = container[key]
  }
  if (parent === null || typeof parent !== 'object') {
    throw new Error(`config patch: path '${renderConfigPath(patch.path)}' does not resolve`)
  }
  const container = parent as Record<string | number, unknown>
  if (patch.op === 'set') {
    container[last] = patch.value
    return
  }
  if (patch.op === 'delete') {
    if (Array.isArray(container) && typeof last === 'number') container.splice(last, 1)
    else delete container[last]
    return
  }
  const list = container[last]
  if (list === undefined) container[last] = [patch.value]
  else if (Array.isArray(list)) list.push(patch.value)
  else throw new Error(`config patch: '${renderConfigPath(patch.path)}' is not an array to append to`)
}

/**
 * Applies patches to the config file and writes it back atomically. YAML keeps
 * its comments and formatting (the `yaml` document API is used, not a
 * parse/stringify round trip); JSON is re-serialised with two-space indent.
 */
export function updateConfigFile(file: string, patch: ConfigPatch[]): RawConfigView {
  const resolved = path.resolve(file)
  const format = configFormat(resolved)
  if (!isFile(resolved)) throw new Error(`config ${resolved}: not a file (an inline config cannot be viewed or edited)`)
  const previous = fs.readFileSync(resolved, 'utf8')
  let text: string
  if (format === 'json') {
    const root: unknown = JSON.parse(previous)
    for (const edit of patch) applyPatchValue(root, edit)
    text = JSON.stringify(root, null, 2) + '\n'
  } else {
    const doc = parseDocument(previous)
    for (const edit of patch) {
      if (edit.op === 'set') doc.setIn(edit.path, edit.value)
      else if (edit.op === 'delete') doc.deleteIn(edit.path)
      else {
        const current = doc.getIn(edit.path)
        if (current === undefined) doc.setIn(edit.path, [edit.value])
        else if (isSeq(current)) current.add(edit.value)
        else throw new Error(`config patch: '${renderConfigPath(edit.path)}' is not an array to append to`)
      }
    }
    text = String(doc)
  }
  // Parse the result BEFORE touching the file: an invalid edit never lands.
  const value: unknown = format === 'json' ? JSON.parse(text) : parseYaml(text)
  const tmp = `${resolved}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 })
  fs.renameSync(tmp, resolved)
  return { file: resolved, writable: true, text, value }
}
