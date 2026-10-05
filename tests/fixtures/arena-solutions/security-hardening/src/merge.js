const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Recursively merges source into target (in place) and returns target. Prototype-related keys are ignored. */
export function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    const value = source[key]
    if (isObject(value)) {
      if (!Object.hasOwn(target, key) || !isObject(target[key])) target[key] = {}
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}
