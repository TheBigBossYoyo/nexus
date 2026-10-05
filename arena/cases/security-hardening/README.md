# security-hardening

Category: security. Complexity: large (high). Risk: high.

## What it measures
Whether an agent finds and closes several independent vulnerability classes across a small library
(path traversal with encoded and Windows-specific variants, prefix-based directory checks, extension
checks by substring, prototype pollution via `JSON.parse` own `__proto__` keys, unescaped template output and
unsafe template lookups, prefix-based origin allow-lists, non-constant-time token comparison) without
over-blocking legitimate input.

## Fixture
`sitekit`: static file resolver/reader, upload saver, deep merge + config loader, template renderer and auth
helpers, with passing visible tests that only cover legitimate use.

## Hidden evaluation
Throws roughly 35 path payloads, 17 upload names, 8 pollution documents, 9 XSS payloads, a set of lookup probes
and look-alike origins at the public API. Properties are asserted rather than exact outputs: a path result must
be inside the root or the call must throw, files outside the root must never be read or created, prototypes must
be unchanged, escaped output must decode back to the original value. Legitimate inputs (percent-encoded spaces,
query strings, directories named `..hidden`, unicode and spaced upload names, similar-looking config keys,
numbers and nested template data, `$&` in values) must still work.

## Why it is fair
The prompt names the attack classes and the error convention (throw `Error` vs return `false`) but no payloads.
Tests use only exported functions; there is no requirement on file layout or internal helpers, and several
valid designs (reject vs confine) are accepted for hostile upload names. Superficial fixes fail: `startsWith`
with a trailing separator but no decoding handling, single-pass `replace('../', '')`, `timingSafeEqual` on
unequal lengths (throws on multi-byte input), escaping only `<` and `>`, or blocking the key `__proto__` but
not `constructor`.

## Version 2
The task prompt now states the requirements the evaluator checks that were previously implicit: the shape of `saveUpload`'s returned name and its confinement, the ignored prototype keys, own-property-only template lookups (objects render empty), and `false` for non-string or empty predicate arguments.
