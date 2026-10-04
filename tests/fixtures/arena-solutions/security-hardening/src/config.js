import { deepMerge } from './merge.js'

/** Parses a JSON config document and layers it over a copy of the defaults. */
export function loadConfig(jsonText, defaults = {}) {
  const parsed = JSON.parse(jsonText)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Config must be a JSON object')
  }
  return deepMerge(structuredClone(defaults), parsed)
}
