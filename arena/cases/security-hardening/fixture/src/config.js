import { deepMerge } from './merge.js'

/** Parses a JSON config document and layers it over a copy of the defaults. */
export function loadConfig(jsonText, defaults = {}) {
  const parsed = JSON.parse(jsonText)
  return deepMerge(structuredClone(defaults), parsed)
}
