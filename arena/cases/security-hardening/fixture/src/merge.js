function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Recursively merges source into target (in place) and returns target. */
export function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (isObject(value)) {
      if (!isObject(target[key])) target[key] = {}
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}
