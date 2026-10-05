# Contracts (0.5)

A contract is a file in one repository that other repositories depend on: an API description, a schema, a
typed interface, a database definition. When a mission changes it, NEXUS compares the new file with the old
one from the consumers' side and says whether an existing consumer can break. This page states exactly what
that comparison decides and where it stops.

Workspace model: [WORKSPACES.md](WORKSPACES.md). The mission that uses these results:
[MULTI_REPO_ORCHESTRATION.md](MULTI_REPO_ORCHESTRATION.md). Release bumps that follow from them:
[RELEASE_TRAINS.md](RELEASE_TRAINS.md).

Source: `src/main/modules/workspace/contracts.ts` (reading a file into a surface), `src/shared/workspace.ts`
(`compareSurfaces`), `src/main/modules/workspace/engine.ts` (registration, consumers, capture, verification).
Everything is deterministic and local: no tool is run and nothing is fetched.

## What a contract is

| Field | Meaning |
|---|---|
| `key` | Lower-case letters, digits and dashes, at most 40 characters, unique in the workspace. Plans refer to a contract by key |
| `name` | A display name (the key when empty) |
| `kind` | One of the six kinds below. You choose it; NEXUS does not guess it from the file name |
| provider | The enrolled repository that owns the file |
| `path` | The path of the file inside the provider repository |

Registering (`workspace.registerContract`, Contracts tab) requires that the file exists at `HEAD` of the
provider and captures its first version. A path must be inside the repository: relative, with no `..`, not
starting with `/` or `-`, no drive letter, and no `:`, line break or NUL.

## Kinds and how the surface is read

A contract file is read into a surface: a list of elements, each with a path, a shape (a normalized
description) and a `required` flag. Only the surface is compared; everything the extractors do not read is
invisible to the comparison.

| Kind | File | Elements |
|---|---|---|
| `openapi` | JSON only. YAML is refused with a parse error, not guessed | One element per operation (`GET /orders/{id}`, shape `responses:200,404`); one per parameter (`GET /orders/{id} #param:path.id`, shape the parameter's schema, required as declared); one per field of the request body (`POST /orders .request.total`); one per field of each response's schema (`GET /orders/{id} .response.200.id`) |
| `json_schema` | JSON | One element per property, by path (`Order.total`, `Order.lines[].sku`), prefixed by the schema's `title` when it has one; the named `definitions` and `$defs` as well. `required` is whether the parent lists it |
| `typescript_api` | `.ts` or `.d.ts` | Exported functions, constants, types, enums, interfaces and classes (`export parseDuration`), and the typed members of each interface and class (`Options.locale`) |
| `protobuf` | `.proto` | Messages (`Order`), their fields (`Order.id`, shape with label, type and field number), enums with their values, and service methods (`Orders.Get`) |
| `database_schema` | SQL | Tables (`orders`) and columns (`orders.total`, shape the column type) of `CREATE TABLE` statements |
| `event_schema` | JSON | One element per event name, and the properties of each event's schema. A file that is itself a JSON Schema (has `properties`, `$schema` or `type`) is read as `json_schema` |

Details that matter when you rely on a result:

- JSON Schema and OpenAPI: a shape is the type (several types sorted and joined with `|`, or `enum`, `object`,
  `any`), the sorted enum values, the `format`, and for arrays the shape of the items. Only local references
  (`#/...`) are resolved; a reference to another file is not. Nesting is read to depth 8 and a surface keeps at
  most 2000 elements (sorted by path, the rest dropped). `allOf`, `oneOf`, `anyOf` and `not` are not walked.
  For OpenAPI only the first media type of a body, in name order, that has a schema is read. Headers, security,
  servers and `components` that no operation references are not read.
- TypeScript: a lexical read with regular expressions, not a type check. Re-exports (`export { x }`,
  `export *`) and `export default` are not read. A function's shape is its parameter text and return type; a
  parameter list is cut at the first closing parenthesis, so a parameter whose type contains parentheses is
  read only up to there. Generic parameters of functions and types are not part of the shape. `export const`
  without a type annotation has the shape `const inferred`, so a change of its value does not change the
  surface. Interface and class members are read only when they have a type annotation. A file with no
  exported declaration is a parse error.
- Protobuf: a message's name and its fields are read with a pattern that allows one level of nested braces; a
  nested message is not read as a message of its own. A field is identified by its name; its shape holds the
  label, type and number. Options, imports and `reserved` are not read. A file with no message, enum or service
  is a parse error.
- Database: only `CREATE TABLE` statements. Table and column names are lower-cased. A column's shape is its type
  with `NOT NULL`, `NULL`, `PRIMARY KEY`, `UNIQUE`, `AUTOINCREMENT`, `DEFAULT`, `REFERENCES` and `CHECK` removed,
  and it is required when it is `NOT NULL` or a primary key. Table-level constraints and indexes are skipped.
  `ALTER TABLE`, views, indexes and migration histories are not read. A file with no `CREATE TABLE` is a parse
  error.
- A file that cannot be read as its kind (invalid JSON, YAML OpenAPI, no recognizable declaration) gets a
  parse error and an empty surface. The comparison then reports `unknown`, never `compatible`.

Contract versions identify content by a SHA-256 of the file, with `CRLF` read as `LF` (the same commit checked
out on Windows and elsewhere has one hash). Any other change, including whitespace and comments, changes the
hash.

## Consumers and copies

A consumer is an enrolled repository that uses the contract. `workspace.addConsumer` (Contracts tab) takes the
repository and an optional copy path.

- The copy path is where the consumer keeps its own copy of the contract: a vendored schema, a generated client
  or its source. Same path rules as above. The file does not have to exist when you declare it.
- The provider cannot be a consumer, and a repository is a consumer of a contract once.
- Declaring a consumer also adds an edge from the consumer to the provider to the organization graph, with
  the source `contract` (WORKSPACES.md).

What the engine does with consumers: a task that names a contract in a consumer repository is told the
provider's new content and, when there is a copy path, to make the copy exactly equal to it; the global
verification checks each consumer (below).

## Versions

A contract version is an integer, 1, 2, 3 in the order captured, with the content hash, the commit it was read
at, the surface and the parse error, if any. Versions are by content: capturing an older commit whose content
equals an earlier version adds a new version number with that hash, it does not reuse the old number. A
capture whose content equals the latest version records nothing.

When a version is recorded:

| Moment | What is read |
|---|---|
| Registration | The file at `HEAD` of the provider |
| `workspace.captureContract` (the Capture button) | The file at `HEAD` of the provider. This records the committed content whatever produced it; it is not a check |
| A cross-repository mission passes global verification | The file at the provider's result commit of that mission, when its comparison was not `identical` |

A version is read from Git (`git show <commit>:<path>`, at most 4 MB), so it is the committed content, never
the working tree. A version recorded by a mission is recorded only for verified work: a mission that fails
verification, or is cancelled, records none (`tests/stress/workspace-stress.test.ts` checks that no version
beyond the first exists for a mission that did not complete). `nextContractVersion` in `src/shared/workspace.ts`
(a semantic version label from a comparison level) is a tested helper that the engine does not call.

## Comparing two surfaces (`compareSurfaces`)

The comparison takes a before and an after and answers from the consumers' side.

### The level

| Level | When | `compatible` |
|---|---|---|
| `identical` | The two content hashes are equal | true |
| `unknown` | The hashes differ and either side has a parse error | false |
| `breaking` | The surfaces differ and at least one change is breaking | false |
| `compatible` | The hashes differ and no change is breaking. This includes a file that changed with a surface that did not (for example a comment or formatting change), reported as `The contract file changed; its surface did not.` | true |

### The changes

Elements are matched by path. For each element of the after surface that was not in the before surface, each
element present in both, and each element that was removed:

| Change | Rule | Breaking |
|---|---|---|
| `removed` | The path is not in the after surface | Always |
| `changed` | The path exists in both and the shapes differ | Always |
| `added` | The path is new | Only when the element is required and an input |
| `now_required` | Same shape, optional before and required after | Only for an input |
| `now_optional` | Same shape, required before and optional after | Only for an output |

An element is an input when its path starts a word (at the start or after a space) with `request`, `param`,
`parameter`, `argument` or `input`, contains `.request.`, or contains `#param:`. Everything else is an output,
read by consumers. For `openapi` this separates request fields and parameters (inputs) from operations and
responses (outputs). For every other kind the paths do not normally contain those words, so every element
counts as an output. The code has no other way to tell which direction a field flows.

The consequences are the exact decisions of the code, not what a person might expect:

| Change | Decision |
|---|---|
| A field, operation, export, column or message is removed | breaking |
| A shape changes: a type, a format, a different set of enum values (so adding an enum value too), a different set of response codes (so adding a `404` too), a changed function signature or field number | breaking |
| A new optional element, or any new element of a non-`openapi` kind | compatible |
| A new required request field or required parameter in an OpenAPI document | breaking |
| A new required property in a `json_schema`, a new `NOT NULL` column, a new required interface member | compatible (they count as outputs) |
| An output that was required becomes optional (for example a column loses `NOT NULL`, a property leaves `required`) | breaking |
| An output that was optional becomes required | compatible |
| An OpenAPI request field or parameter that was required becomes optional | compatible |
| An OpenAPI request field or parameter that was optional becomes required | breaking |
| A protobuf field renamed with the same number | breaking (the old name is removed, a new one added) |

Changes are sorted by path. The summary names up to four changes (`2 breaking change(s): removed Order.total;
...`).

`tests/unit/workspace/workspace-model.test.ts` covers surfaces for each kind, the compatibility rules for a new
optional field, a removed field, a retyped field, a newly absent output, a new required request field, a relaxed
requirement, a formatting-only change and an unreadable file.

### What the comparison does not see

- Anything the extractors do not read (see the table above and its notes): descriptions, default values,
  numeric and string constraints (`minimum`, `pattern`, `maxLength`), `additionalProperties`, composition
  keywords (`allOf`, `oneOf`, `anyOf`), external references, OpenAPI headers, security and servers, TypeScript
  re-exports and inferred constants, protobuf options, SQL constraints, defaults and indexes. A change in them
  changes the file's hash and, unless it changes a read element, is reported as `compatible` with no changes.
- Behaviour. A contract is a file; two implementations with the same file may behave differently.
- Whether a field is really an input or an output of a JSON Schema, a TypeScript interface or a table: all are
  treated as outputs, so a JSON Schema used as a request body is judged as if consumers only read it.
- Whether a consumer actually uses an element.
- A surface larger than 2000 elements, or nesting deeper than 8 levels.

A comparison that says `compatible` therefore means that NEXUS saw no breaking change in what it reads. It does
not mean the contract is safe. `unknown` and `breaking` are treated as breaking by the rest of the engine.

## In a mission

A mission's contract is compared against the mission's own base, not against the latest stored version.

- Before: the contract file at the base commit of the provider's first task in the mission (or at `HEAD` of the
  provider when the mission has no task there).
- After: the file at the provider's newest result commit in the mission.
- `fromVersion` is the latest stored version whose hash equals the before content, or none (shown as new)
  when that content was never captured. `toVersion` is the stored version whose hash equals the after
  content, or the next number when none does.

So a version someone captured from an unrelated commit does not change what a mission is judged against. This
comparison is done during verification and stores nothing. When verification passes and the comparison was not
`identical`, the after content is captured as a new version, and a `contract` memory entry records the change
and which consumers are in step.

The contracts a mission checks are those a task names in `contracts` and those whose provider repository the
mission changed.

What the verification does with the result, for each consumer (MULTI_REPO_ORCHESTRATION.md has the full
checks):

| Consumer | Passes when |
|---|---|
| With a copy path | The copy, read at the consumer's result, has the same hash as the provider's new file; or the change is not breaking (then it is reported as an older, compatible version); or `requireConsumerUpdateOnBreakingChange` is off |
| Without a copy path | The mission changed that repository, or the change is not breaking, or the policy setting is off |

A contract file that cannot be read as its kind after the mission fails the mission (`contract <key> is
readable`).

The release plan uses the strongest level per provider repository: `breaking` and `unknown` give a major bump
of the provider, `compatible` a minor bump (RELEASE_TRAINS.md).

## Capture

`workspace.captureContract` reads the contract at `HEAD` of the provider and records a new version when its
content differs from the latest one. It returns the version, how it compares with the one before (against the
latest stored version, not against a mission's base) and whether anything was recorded. It also writes a
`contract_changed` decision when a version was added after another. Use it when someone changed a contract
outside NEXUS and you want the history to follow. The Contracts tab shows the version list and the latest
comparison.

## Limits

- Six kinds, each read by a small deterministic reader written for NEXUS, not by the format's own tooling. A
  contract in any other format, or a file that does not parse by these readers, is `unknown`.
- OpenAPI must be JSON. A YAML document is registered but
  reads as a parse error and every comparison of it is `unknown`.
- A TypeScript contract is read lexically; type-level meaning (inheritance, generics, overloads) is not
  followed.
- The input and output rule is per path, and only OpenAPI paths carry the direction.
- Contract versions are not semantic versions of the repository, and NEXUS does not write them anywhere.
- The mission's provider read falls back to `HEAD` of the provider's checkout when the mission did not change
  the provider (MULTI_REPO_ORCHESTRATION.md, Limits).
- Capture records committed content only. An uncommitted change to a contract file is not seen.
- What the tests cover: `tests/unit/workspace/workspace-model.test.ts`; `tests/integration/workspace/engine.test.ts`
  (versions by content, a compatible and a breaking change, path confinement, a breaking change with a consumer
  left behind that fails verification, and the same consumer left behind on a compatible change that passes);
  `tests/scenarios/v5-workspace.test.ts` (a contract changed in a provider and copied by two consumers, on the
  real orchestrator). Extraction is tested on small samples of each kind; large real-world files in each
  format were not part of the tests.
