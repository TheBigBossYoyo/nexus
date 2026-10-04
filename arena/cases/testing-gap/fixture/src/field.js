import { CronError } from './errors.js'

function toInt(text, name) {
  if (!/^\d+$/.test(text)) throw new CronError(`invalid number "${text}" in ${name} field`)
  return Number(text)
}

/**
 * Expand one cron field into a sorted list of unique integers.
 *
 * Supported: `*`, a number, `a-b`, `*` or `a-b` or `a` followed by `/step`, and comma lists of those.
 * `a/step` means `a` through the field maximum. Month and weekday names are accepted
 * (case-insensitively) when `names` is given. Anything else throws CronError.
 */
export function parseField(text, { name, min, max, names = {} }) {
  const resolve = (token) => {
    const named = names[token.toUpperCase()]
    return named !== undefined ? named : toInt(token, name)
  }
  const values = new Set()
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`empty list item in ${name} field`)
    const [rangePart, stepPart, extra] = part.split('/')
    if (extra !== undefined) throw new CronError(`too many "/" in ${name} field`)
    let step = 1
    if (stepPart !== undefined) {
      step = toInt(stepPart, name)
      if (step < 1) throw new CronError(`step must be at least 1 in ${name} field`)
    }
    let lo
    let hi
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-')
      if (more !== undefined) throw new CronError(`invalid range "${rangePart}" in ${name} field`)
      lo = resolve(a)
      hi = resolve(b)
      if (lo > hi) throw new CronError(`range "${rangePart}" is reversed in ${name} field`)
    } else {
      lo = resolve(rangePart)
      hi = stepPart !== undefined ? max : lo
    }
    if (lo < min || hi > max) throw new CronError(`${name} must be between ${min} and ${max}`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}
