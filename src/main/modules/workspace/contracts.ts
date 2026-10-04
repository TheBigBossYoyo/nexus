import { createHash } from 'node:crypto'
import type { ContractKind, SurfaceElement } from '@shared/workspace'

/**
 * Reads the surface of a contract file: the elements a consumer can depend on. Deterministic and local: no
 * tool is run and nothing is fetched. A file that cannot be read as its kind gives a parse error and an empty
 * surface, which the compatibility check reports as "unknown", never as "compatible".
 */

export interface ExtractedSurface {
  hash: string
  surface: SurfaceElement[]
  parseError: string | null
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)

export function contentHash(content: string): string {
  // Line endings differ between checkouts of the same commit on Windows; they are not part of the contract.
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex')
}

const MAX_DEPTH = 8
const MAX_ELEMENTS = 2000

/** `type` of a JSON Schema node, with the parts that change what a consumer may send or receive. */
function schemaShape(node: { [key: string]: Json }, root: { [key: string]: Json }): string {
  const resolved = resolveRef(node, root)
  const parts: string[] = []
  const type = resolved['type']
  parts.push(Array.isArray(type) ? [...type].map(String).sort().join('|') : typeof type === 'string' ? type : resolved['enum'] ? 'enum' : isObject(resolved['properties']) ? 'object' : 'any')
  if (Array.isArray(resolved['enum'])) parts.push(`enum(${[...resolved['enum']].map((v) => JSON.stringify(v)).sort().join(',')})`)
  if (typeof resolved['format'] === 'string') parts.push(`format:${resolved['format']}`)
  if (isObject(resolved['items'])) parts.push(`items:${schemaShape(resolved['items'], root)}`)
  return parts.join(' ')
}

function resolveRef(node: { [key: string]: Json }, root: { [key: string]: Json }, depth = 0): { [key: string]: Json } {
  const ref = node['$ref']
  if (typeof ref !== 'string' || !ref.startsWith('#/') || depth > MAX_DEPTH) return node
  let current: Json | undefined = root
  for (const part of ref.slice(2).split('/')) {
    current = isObject(current) ? current[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
  }
  return isObject(current) ? resolveRef(current, root, depth + 1) : node
}

function walkSchema(node: { [key: string]: Json }, root: { [key: string]: Json }, prefix: string, out: SurfaceElement[], depth = 0): void {
  if (depth > MAX_DEPTH || out.length >= MAX_ELEMENTS) return
  const resolved = resolveRef(node, root)
  const properties = resolved['properties']
  const required = Array.isArray(resolved['required']) ? resolved['required'].map(String) : []
  if (isObject(properties)) {
    for (const name of Object.keys(properties).sort()) {
      const child = properties[name]
      if (!isObject(child)) continue
      const path = prefix ? `${prefix}.${name}` : name
      out.push({ path, shape: schemaShape(child, root), required: required.includes(name) })
      walkSchema(child, root, path, out, depth + 1)
    }
  }
  const items = resolved['items']
  if (isObject(items)) walkSchema(items, root, `${prefix}[]`, out, depth + 1)
}

function jsonSchemaSurface(content: string): SurfaceElement[] {
  const root = JSON.parse(content) as Json
  if (!isObject(root)) throw new Error('The schema is not a JSON object')
  const out: SurfaceElement[] = []
  const title = typeof root['title'] === 'string' ? root['title'] : ''
  walkSchema(root, root, title, out)
  // Named definitions are part of the surface too: consumers generate types from them.
  for (const bucket of ['definitions', '$defs']) {
    const defs = root[bucket]
    if (!isObject(defs)) continue
    for (const name of Object.keys(defs).sort()) {
      const def = defs[name]
      if (isObject(def)) walkSchema(def, root, name, out)
    }
  }
  if (out.length === 0) out.push({ path: title || '#', shape: schemaShape(root, root), required: true })
  return out
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const

function openApiSurface(content: string): SurfaceElement[] {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('{')) throw new Error('Only JSON OpenAPI documents are read; this file is not JSON (YAML is not supported)')
  const root = JSON.parse(content) as Json
  if (!isObject(root) || !isObject(root['paths'])) throw new Error('The document has no "paths" object')
  const out: SurfaceElement[] = []
  const paths = root['paths']
  for (const route of Object.keys(paths).sort()) {
    const item = paths[route]
    if (!isObject(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isObject(operation)) continue
      const name = `${method.toUpperCase()} ${route}`
      const responses = isObject(operation['responses']) ? Object.keys(operation['responses']).sort() : []
      out.push({ path: name, shape: `responses:${responses.join(',')}`, required: true })
      const parameters = [...(Array.isArray(item['parameters']) ? item['parameters'] : []), ...(Array.isArray(operation['parameters']) ? operation['parameters'] : [])]
      for (const raw of parameters) {
        if (!isObject(raw)) continue
        const p = resolveRef(raw, root)
        const schema = isObject(p['schema']) ? schemaShape(p['schema'], root) : 'any'
        out.push({ path: `${name} #param:${String(p['in'] ?? 'query')}.${String(p['name'] ?? '?')}`, shape: schema, required: p['required'] === true })
      }
      const body = isObject(operation['requestBody']) ? resolveRef(operation['requestBody'], root) : null
      const bodySchema = body && isObject(body['content']) ? firstSchema(body['content']) : null
      if (bodySchema) walkSchema(bodySchema, root, `${name} .request`, out)
      if (isObject(operation['responses'])) {
        for (const code of Object.keys(operation['responses']).sort()) {
          const response = operation['responses'][code]
          const resolved = isObject(response) ? resolveRef(response, root) : null
          const schema = resolved && isObject(resolved['content']) ? firstSchema(resolved['content']) : null
          if (schema) walkSchema(schema, root, `${name} .response.${code}`, out)
        }
      }
    }
  }
  return out
}

function firstSchema(content: { [key: string]: Json }): { [key: string]: Json } | null {
  for (const media of Object.keys(content).sort()) {
    const entry = content[media]
    if (isObject(entry) && isObject(entry['schema'])) return entry['schema']
  }
  return null
}

const squash = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()

/** Exported declarations of a TypeScript (or .d.ts) file. A lexical read, not a type check. */
function typescriptSurface(content: string): SurfaceElement[] {
  const out: SurfaceElement[] = []
  const source = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const body = (from: number): string => {
    let depth = 0
    for (let i = from; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) return source.slice(from + 1, i)
    }
    return ''
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;\n]+))?/g)) {
    out.push({ path: `export ${m[1]}`, shape: squash(`(${m[3] ?? ''}) => ${m[4] ?? 'unknown'}`), required: true })
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?const\s+(\w+)\s*(?::\s*([^=;\n]+))?/g)) {
    out.push({ path: `export ${m[1]}`, shape: squash(`const ${m[2] ?? 'inferred'}`), required: true })
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=\s*([^;\n]+(?:\n\s+[|&][^;\n]+)*)/g)) {
    out.push({ path: `export ${m[1]}`, shape: squash(`type ${m[2] ?? ''}`), required: true })
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?enum\s+(\w+)\s*\{/g)) {
    out.push({ path: `export ${m[1]}`, shape: squash(`enum ${body(source.indexOf('{', m.index ?? 0))}`), required: true })
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(interface|class)\s+(\w+)[^{]*\{/g)) {
    const name = m[2] ?? ''
    out.push({ path: `export ${name}`, shape: m[1] ?? 'interface', required: true })
    const members = body(source.indexOf('{', m.index ?? 0))
    for (const member of members.matchAll(/^\s*(?:public\s+|readonly\s+|static\s+)*(\w+)(\?)?\s*(\([^)]*\))?\s*:\s*([^;\n]+)/gm)) {
      if (['private', 'protected', 'constructor'].includes(member[1] ?? '')) continue
      out.push({ path: `${name}.${member[1]}`, shape: squash(`${member[3] ?? ''}${member[3] ? ' => ' : ''}${member[4] ?? ''}`), required: member[2] !== '?' })
    }
  }
  if (out.length === 0) throw new Error('No exported declaration was found')
  return dedupe(out)
}

function protobufSurface(content: string): SurfaceElement[] {
  const out: SurfaceElement[] = []
  const source = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const m of source.matchAll(/\bmessage\s+(\w+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    const name = m[1] ?? ''
    out.push({ path: name, shape: 'message', required: true })
    for (const f of (m[2] ?? '').matchAll(/^\s*(repeated\s+|optional\s+|required\s+)?([\w.<>, ]+?)\s+(\w+)\s*=\s*(\d+)/gm)) {
      const label = (f[1] ?? '').trim()
      out.push({ path: `${name}.${f[3]}`, shape: squash(`${label} ${f[2]} = ${f[4]}`), required: label === 'required' })
    }
  }
  for (const m of source.matchAll(/\benum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const values = [...(m[2] ?? '').matchAll(/(\w+)\s*=\s*(-?\d+)/g)].map((v) => `${v[1]}=${v[2]}`).sort()
    out.push({ path: m[1] ?? '', shape: `enum ${values.join(',')}`, required: true })
  }
  for (const m of source.matchAll(/\bservice\s+(\w+)\s*\{([^}]*)\}/g)) {
    for (const rpc of (m[2] ?? '').matchAll(/rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g)) {
      out.push({ path: `${m[1]}.${rpc[1]}`, shape: squash(`(${rpc[2] ?? ''}${rpc[3]}) returns (${rpc[4] ?? ''}${rpc[5]})`), required: true })
    }
  }
  if (out.length === 0) throw new Error('No message, enum or service was found')
  return dedupe(out)
}

/** Tables and columns of `CREATE TABLE` statements. */
function databaseSurface(content: string): SurfaceElement[] {
  const out: SurfaceElement[] = []
  const source = content.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of source.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)[`"\]]?\s*\(([\s\S]*?)\)\s*(?:;|$|without|engine|strict)/gi)) {
    const table = (m[1] ?? '').toLowerCase()
    out.push({ path: table, shape: 'table', required: true })
    // Split on commas that are not inside parentheses (types such as numeric(10, 2)).
    const columns: string[] = []
    let depth = 0
    let current = ''
    for (const ch of m[2] ?? '') {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        columns.push(current)
        current = ''
      } else current += ch
    }
    columns.push(current)
    for (const raw of columns) {
      const column = raw.trim().replace(/\s+/g, ' ')
      if (column === '' || /^(primary key|foreign key|unique|check|constraint|index|key)\b/i.test(column)) continue
      const match = /^[`"[]?(\w+)[`"\]]?\s+(.+)$/.exec(column)
      if (!match) continue
      const rest = (match[2] ?? '').toLowerCase()
      const type = rest.replace(/\b(not null|null|primary key|unique|autoincrement|auto_increment|default\s+('[^']*'|\S+)|references\s+\S+(\s*\([^)]*\))?(\s+on\s+(delete|update)\s+\w+(\s+\w+)?)*|check\s*\(.*\))/g, '').replace(/\s+/g, ' ').trim()
      out.push({ path: `${table}.${(match[1] ?? '').toLowerCase()}`, shape: type || 'unspecified', required: /\bnot null\b|\bprimary key\b/.test(rest) })
    }
  }
  if (out.length === 0) throw new Error('No CREATE TABLE statement was found')
  return dedupe(out)
}

/** Event schemas are JSON: either one JSON Schema, or an object whose keys are event names and values schemas. */
function eventSurface(content: string): SurfaceElement[] {
  const root = JSON.parse(content) as Json
  if (!isObject(root)) throw new Error('The event schema is not a JSON object')
  if (root['properties'] || root['$schema'] || root['type']) return jsonSchemaSurface(content)
  const events = isObject(root['events']) ? root['events'] : root
  const out: SurfaceElement[] = []
  for (const name of Object.keys(events).sort()) {
    const schema = events[name]
    if (!isObject(schema)) continue
    out.push({ path: name, shape: 'event', required: true })
    walkSchema(schema, root, name, out)
  }
  if (out.length === 0) throw new Error('No event was found')
  return out
}

function dedupe(elements: SurfaceElement[]): SurfaceElement[] {
  const seen = new Map<string, SurfaceElement>()
  for (const e of elements) if (!seen.has(e.path)) seen.set(e.path, e)
  // Code-point order, not the locale's: the same surface must sort the same on every machine.
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, MAX_ELEMENTS)
}

const EXTRACTORS: Record<ContractKind, (content: string) => SurfaceElement[]> = {
  openapi: openApiSurface,
  json_schema: jsonSchemaSurface,
  typescript_api: typescriptSurface,
  protobuf: protobufSurface,
  database_schema: databaseSurface,
  event_schema: eventSurface,
}

export function extractSurface(kind: ContractKind, content: string): ExtractedSurface {
  const hash = contentHash(content)
  try {
    return { hash, surface: dedupe(EXTRACTORS[kind](content)), parseError: null }
  } catch (e) {
    return { hash, surface: [], parseError: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
}

/** Guess a contract's kind from its file name; null when the name does not say. */
export function guessContractKind(path: string): ContractKind | null {
  const name = path.toLowerCase()
  if (/openapi|swagger/.test(name) && name.endsWith('.json')) return 'openapi'
  if (name.endsWith('.proto')) return 'protobuf'
  if (name.endsWith('.sql')) return 'database_schema'
  if (name.endsWith('.d.ts') || name.endsWith('.ts')) return 'typescript_api'
  if (/event/.test(name) && name.endsWith('.json')) return 'event_schema'
  if (name.endsWith('.schema.json') || (name.endsWith('.json') && /schema/.test(name))) return 'json_schema'
  return null
}
