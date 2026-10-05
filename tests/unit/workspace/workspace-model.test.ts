import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bumpVersion,
  canTransitionWorkspaceMission,
  compareSurfaces,
  DEFAULT_WORKSPACE_POLICY,
  dependencyOrder,
  dependentsOf,
  nextContractVersion,
  planRelease,
  TERMINAL_WORKSPACE_MISSION_STATES,
  validateWorkspacePlan,
  WORKSPACE_MISSION_STATES,
  WorkspacePlanSchema,
  WorkspacePolicySchema,
  type PlannedCrossRepoTask,
} from '@shared/workspace'
import { contentHash, extractSurface, guessContractKind } from '@main/modules/workspace/contracts'
import { discoverManifestEdges, readManifest } from '@main/modules/workspace/discovery'

const task = (key: string, repository: string, over: Partial<PlannedCrossRepoTask> = {}): PlannedCrossRepoTask => ({ key, repository, title: `T ${key}`, objective: `Do ${key}`, acceptanceCriteria: [`${key} ok`], dependsOn: [], contracts: [], ...over })

describe('dependency order', () => {
  const edges = [
    { from: 'backend', to: 'shared-sdk' },
    { from: 'desktop', to: 'backend' },
    { from: 'desktop', to: 'shared-sdk' },
    { from: 'docs', to: 'desktop' },
  ]
  it('orders providers before consumers, deterministically, with levels', () => {
    const result = dependencyOrder(['docs', 'desktop', 'website', 'backend', 'shared-sdk'], edges)
    expect(result).toEqual({ ok: true, order: ['shared-sdk', 'website', 'backend', 'desktop', 'docs'], levels: [['shared-sdk', 'website'], ['backend'], ['desktop'], ['docs']] })
  })

  it('reports a cycle instead of ordering it, and ignores edges to unknown nodes and self-edges', () => {
    expect(dependencyOrder(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])).toEqual({ ok: false, cycle: ['a', 'b'] })
    expect(dependencyOrder(['a'], [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }])).toMatchObject({ ok: true, order: ['a'] })
  })

  it('finds everything that depends on a repository, directly or not', () => {
    expect(dependentsOf('shared-sdk', edges)).toEqual(['backend', 'desktop', 'docs'])
    expect(dependentsOf('docs', edges)).toEqual([])
  })
})

describe('contract surfaces', () => {
  it('json schema: properties, nested objects, arrays, required, definitions', () => {
    const { surface, parseError } = extractSurface(
      'json_schema',
      JSON.stringify({ title: 'Order', type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' }, total: { type: 'number' }, lines: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } }, status: { enum: ['open', 'paid'] } } }),
    )
    expect(parseError).toBeNull()
    expect(surface).toEqual([
      { path: 'Order.id', shape: 'string format:uuid', required: true },
      { path: 'Order.lines', shape: 'array items:object', required: false },
      { path: 'Order.lines[].sku', shape: 'string', required: true },
      { path: 'Order.status', shape: 'enum enum("open","paid")', required: false },
      { path: 'Order.total', shape: 'number', required: false },
    ])
  })

  it('openapi: operations, parameters, request and response fields, local refs; YAML is refused, not guessed', () => {
    const doc = {
      openapi: '3.0.0',
      paths: { '/orders/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, 404: {} } }, post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } } } }, responses: { 201: {} } } } },
      components: { schemas: { Order: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
    }
    const { surface, parseError } = extractSurface('openapi', JSON.stringify(doc))
    expect(parseError).toBeNull()
    expect(surface.map((e) => e.path)).toEqual(['GET /orders/{id}', 'GET /orders/{id} #param:path.id', 'GET /orders/{id} .response.200.id', 'POST /orders/{id}', 'POST /orders/{id} .request.total'])
    expect(surface.find((e) => e.path === 'GET /orders/{id}')?.shape).toBe('responses:200,404')
    expect(extractSurface('openapi', 'openapi: 3.0.0\npaths: {}\n')).toMatchObject({ surface: [], parseError: expect.stringContaining('YAML is not supported') })
  })

  it('typescript: exported functions, constants, types, interfaces with members', () => {
    const { surface, parseError } = extractSurface(
      'typescript_api',
      "/** doc */\nexport function parseDuration(text: string): number\nexport const VERSION: string\nexport interface Options {\n  strict: boolean\n  locale?: string // optional\n  format(value: number): string\n}\nexport type Unit = 's' | 'm' | 'h'\nfunction internal(): void {}\n",
    )
    expect(parseError).toBeNull()
    expect(surface).toEqual([
      { path: 'Options.format', shape: '(value: number) => string', required: true },
      { path: 'Options.locale', shape: 'string', required: false },
      { path: 'Options.strict', shape: 'boolean', required: true },
      { path: 'export Options', shape: 'interface', required: true },
      { path: 'export Unit', shape: "type 's' | 'm' | 'h'", required: true },
      { path: 'export VERSION', shape: 'const string', required: true },
      { path: 'export parseDuration', shape: '(text: string) => number', required: true },
    ])
  })

  it('protobuf: messages with field numbers, enums, services', () => {
    const { surface } = extractSurface('protobuf', 'syntax = "proto3";\nmessage Order {\n  string id = 1;\n  repeated Line lines = 2; // items\n}\nenum Status { OPEN = 0; PAID = 1; }\nservice Orders { rpc Get (GetRequest) returns (Order); }\n')
    expect(surface).toEqual([
      { path: 'Order', shape: 'message', required: true },
      { path: 'Order.id', shape: 'string = 1', required: false },
      { path: 'Order.lines', shape: 'repeated Line = 2', required: false },
      { path: 'Orders.Get', shape: '(GetRequest) returns (Order)', required: true },
      { path: 'Status', shape: 'enum OPEN=0,PAID=1', required: true },
    ])
  })

  it('database schema: tables, column types, NOT NULL', () => {
    const { surface } = extractSurface('database_schema', 'CREATE TABLE IF NOT EXISTS orders (\n  id TEXT PRIMARY KEY,\n  total NUMERIC(10, 2) NOT NULL DEFAULT 0, -- money\n  note TEXT,\n  FOREIGN KEY (id) REFERENCES x(id)\n);\n')
    expect(surface).toEqual([
      { path: 'orders', shape: 'table', required: true },
      { path: 'orders.id', shape: 'text', required: true },
      { path: 'orders.note', shape: 'text', required: false },
      { path: 'orders.total', shape: 'numeric(10, 2)', required: true },
    ])
  })

  it('event schema: one schema per event name', () => {
    const { surface } = extractSurface('event_schema', JSON.stringify({ events: { 'order.paid': { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' }, at: { type: 'string', format: 'date-time' } } } } }))
    expect(surface.map((e) => [e.path, e.required])).toEqual([
      ['order.paid', true],
      ['order.paid.at', false],
      ['order.paid.orderId', true],
    ])
  })

  it('a file that cannot be read as its kind has a parse error and an empty surface', () => {
    expect(extractSurface('json_schema', '{ not json')).toMatchObject({ surface: [], parseError: expect.any(String) })
    expect(extractSurface('database_schema', 'SELECT 1;')).toMatchObject({ surface: [], parseError: expect.stringContaining('CREATE TABLE') })
    expect(extractSurface('typescript_api', 'const x = 1')).toMatchObject({ surface: [], parseError: expect.any(String) })
  })

  it('the hash ignores line endings and nothing else', () => {
    expect(contentHash('a\r\nb\r\n')).toBe(contentHash('a\nb\n'))
    expect(contentHash('a\nb\n')).not.toBe(contentHash('a\nb'))
  })

  it('guesses a kind from the file name only when the name says so', () => {
    expect(guessContractKind('api/openapi.json')).toBe('openapi')
    expect(guessContractKind('proto/orders.proto')).toBe('protobuf')
    expect(guessContractKind('db/schema.sql')).toBe('database_schema')
    expect(guessContractKind('src/index.d.ts')).toBe('typescript_api')
    expect(guessContractKind('contracts/order.schema.json')).toBe('json_schema')
    expect(guessContractKind('events/order-events.json')).toBe('event_schema')
    expect(guessContractKind('README.md')).toBeNull()
  })
})

describe('contract compatibility', () => {
  const version = (kind: 'json_schema' | 'openapi' | 'typescript_api', value: unknown) => extractSurface(kind, typeof value === 'string' ? value : JSON.stringify(value))
  const order = (properties: Record<string, unknown>, required: string[] = ['id']) => ({ title: 'Order', type: 'object', required, properties })

  it('identical content is identical; a formatting-only change is compatible', () => {
    const a = version('json_schema', order({ id: { type: 'string' } }))
    expect(compareSurfaces(a, a)).toMatchObject({ compatible: true, level: 'identical' })
    const b = version('json_schema', JSON.stringify(order({ id: { type: 'string' } }), null, 2))
    expect(compareSurfaces(a, b)).toMatchObject({ compatible: true, level: 'compatible', changes: [] })
  })

  it('adding an optional field is compatible; removing or retyping one is breaking', () => {
    const before = version('json_schema', order({ id: { type: 'string' }, total: { type: 'number' } }))
    const added = compareSurfaces(before, version('json_schema', order({ id: { type: 'string' }, total: { type: 'number' }, currency: { type: 'string' } })))
    expect(added).toMatchObject({ compatible: true, level: 'compatible' })
    expect(added.changes).toEqual([expect.objectContaining({ path: 'Order.currency', change: 'added', breaking: false })])
    const removed = compareSurfaces(before, version('json_schema', order({ id: { type: 'string' } })))
    expect(removed).toMatchObject({ compatible: false, level: 'breaking' })
    expect(removed.changes[0]).toMatchObject({ path: 'Order.total', change: 'removed', breaking: true })
    const retyped = compareSurfaces(before, version('json_schema', order({ id: { type: 'string' }, total: { type: 'string' } })))
    expect(retyped.changes[0]).toMatchObject({ change: 'changed', before: 'number', after: 'string', breaking: true })
    expect(retyped.summary).toContain('1 breaking change')
  })

  it('an output that may now be absent is breaking; a new required request field is breaking; a relaxed one is not', () => {
    const before = version('json_schema', order({ id: { type: 'string' }, total: { type: 'number' } }, ['id', 'total']))
    expect(compareSurfaces(before, version('json_schema', order({ id: { type: 'string' }, total: { type: 'number' } }, ['id']))).changes[0]).toMatchObject({ change: 'now_optional', breaking: true })
    const api = (required: string[], properties: Record<string, unknown>) => ({ paths: { '/orders': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required, properties } } } }, responses: { 201: {} } } } } })
    const v1 = version('openapi', api(['total'], { total: { type: 'number' } }))
    const stricter = compareSurfaces(v1, version('openapi', api(['total', 'currency'], { total: { type: 'number' }, currency: { type: 'string' } })))
    expect(stricter.changes).toEqual([expect.objectContaining({ path: 'POST /orders .request.currency', change: 'added', breaking: true })])
    const relaxed = compareSurfaces(v1, version('openapi', api([], { total: { type: 'number' } })))
    expect(relaxed).toMatchObject({ compatible: true })
    expect(relaxed.changes[0]).toMatchObject({ change: 'now_optional', breaking: false })
  })

  it('an unreadable version is unknown, never compatible', () => {
    const good = version('json_schema', order({ id: { type: 'string' } }))
    const bad = extractSurface('json_schema', '{ broken')
    expect(compareSurfaces(good, bad)).toMatchObject({ compatible: false, level: 'unknown' })
    expect(compareSurfaces(bad, good)).toMatchObject({ compatible: false, level: 'unknown' })
  })

  it('versions a contract by what changed', () => {
    expect(nextContractVersion('1.4.2', 'identical')).toBe('1.4.2')
    expect(nextContractVersion('1.4.2', 'compatible')).toBe('1.5.0')
    expect(nextContractVersion('1.4.2', 'breaking')).toBe('2.0.0')
    expect(nextContractVersion('1.4.2', 'unknown')).toBe('2.0.0')
    expect(nextContractVersion('next', 'breaking')).toBe('next')
  })
})

describe('cross-repository plan validation', () => {
  const workspace = { repositories: ['shared-sdk', 'backend', 'desktop', 'vault'], contracts: ['order'], edges: [{ from: 'backend', to: 'shared-sdk' }, { from: 'desktop', to: 'backend' }], policy: { ...DEFAULT_WORKSPACE_POLICY, allowedRepositories: ['shared-sdk', 'backend', 'desktop'] } }

  it('accepts a plan that follows the organization graph', () => {
    const plan = { tasks: [task('sdk', 'shared-sdk', { contracts: ['order'] }), task('api', 'backend', { dependsOn: ['sdk'], contracts: ['order'] }), task('ui', 'desktop', { dependsOn: ['api'] })] }
    expect(validateWorkspacePlan(plan, workspace)).toEqual([])
    expect(WorkspacePlanSchema.safeParse({ summary: 's', tasks: plan.tasks, risks: [] }).success).toBe(true)
  })

  it('rejects unknown and disallowed repositories, unknown contracts, duplicates, unknown dependencies and cycles', () => {
    const problems = (tasks: PlannedCrossRepoTask[]): string[] => validateWorkspacePlan({ tasks }, workspace).map((p) => p.problem)
    expect(problems([task('a', 'nowhere')])).toContain('unknown repository nowhere')
    expect(problems([task('a', 'vault')])).toContain('repository vault is not allowed by the workspace policy')
    expect(problems([task('a', 'backend', { contracts: ['ghost'] })])).toContain('unknown contract ghost')
    expect(problems([task('a', 'backend'), task('a', 'desktop')])).toContain('duplicate task key')
    expect(problems([task('a', 'backend', { dependsOn: ['zz'] })])).toContain('depends on unknown task zz')
    expect(problems([task('a', 'shared-sdk', { dependsOn: ['b'] }), task('b', 'shared-sdk', { dependsOn: ['a'] })]).join(' ')).toContain('dependency cycle')
  })

  it('a consumer task must come after the provider task, directly or through others', () => {
    const wrong = validateWorkspacePlan({ tasks: [task('sdk', 'shared-sdk'), task('api', 'backend')] }, workspace)
    expect(wrong).toEqual([{ task: 'api', problem: 'backend depends on shared-sdk: task api must depend on sdk' }])
    // Transitively is enough.
    expect(validateWorkspacePlan({ tasks: [task('sdk', 'shared-sdk'), task('mid', 'shared-sdk', { dependsOn: ['sdk'] }), task('api', 'backend', { dependsOn: ['mid'] })] }, workspace)).toEqual([])
  })

  it('respects the limits of the policy, and the policy schema refuses publishing', () => {
    const many = validateWorkspacePlan({ tasks: [task('a', 'shared-sdk'), task('b', 'backend', { dependsOn: ['a'] }), task('c', 'desktop', { dependsOn: ['b'] })] }, { ...workspace, policy: { ...workspace.policy, maxRepositoriesPerMission: 2, maxTasksPerMission: 2 } })
    expect(many.map((p) => p.problem)).toEqual(['the plan spans 3 repositories, above the limit of 2', 'the plan has 3 tasks, above the limit of 2'])
    expect(WorkspacePolicySchema.safeParse(DEFAULT_WORKSPACE_POLICY).success).toBe(true)
    expect(WorkspacePolicySchema.safeParse({ ...DEFAULT_WORKSPACE_POLICY, publishing: 'automatic' }).success).toBe(false)
    expect(WorkspacePolicySchema.safeParse({ ...DEFAULT_WORKSPACE_POLICY, command: 'npm publish' }).success).toBe(false)
    expect(DEFAULT_WORKSPACE_POLICY.allowedRepositories).toEqual([])
  })
})

describe('release planning', () => {
  const edges = [{ from: 'backend', to: 'shared-sdk' }, { from: 'desktop', to: 'backend' }, { from: 'website', to: 'docs' }]
  const repo = (key: string, version: string | null, changed: boolean) => ({ key, version, branch: changed ? `nexus/integration-${key}` : null, commit: changed ? `c-${key}` : null, changed })

  it('orders the release and bumps by what changed, including repositories that only depend on a released one', () => {
    const plan = planRelease({ repositories: [repo('desktop', '0.7.3', false), repo('backend', '1.8.4', true), repo('shared-sdk', '2.2.9', true), repo('website', '3.0.0', false), repo('docs', '1.0.0', false)], edges, contractChanges: [{ repository: 'shared-sdk', level: 'compatible' }] })
    expect(plan.problems).toEqual([])
    expect(plan.steps.map((s) => [s.repository, s.currentVersion, s.nextVersion, s.bump, s.after])).toEqual([
      ['shared-sdk', '2.2.9', '2.3.0', 'minor', []],
      ['backend', '1.8.4', '1.8.5', 'patch', ['shared-sdk']],
      ['desktop', '0.7.3', '0.7.4', 'patch', ['backend']],
    ])
    expect(plan.levels).toEqual([['shared-sdk'], ['backend'], ['desktop']])
    // Repositories outside the change are not in the train.
    expect(plan.steps.some((s) => s.repository === 'website' || s.repository === 'docs')).toBe(false)
  })

  it('a breaking contract is a major release of its provider; a cycle has no release order; a missing version is reported', () => {
    const breaking = planRelease({ repositories: [repo('shared-sdk', '2.2.9', true), repo('backend', null, true)], edges, contractChanges: [{ repository: 'shared-sdk', level: 'breaking' }] })
    expect(breaking.steps[0]).toMatchObject({ repository: 'shared-sdk', nextVersion: '3.0.0', bump: 'major' })
    expect(breaking.problems).toEqual(['backend has no version in a manifest; its release cannot be numbered.'])
    const cyclic = planRelease({ repositories: [repo('a', '1.0.0', true), repo('b', '1.0.0', true)], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], contractChanges: [] })
    expect(cyclic.steps).toEqual([])
    expect(cyclic.problems[0]).toContain('cycle')
  })

  it('bumps semantic versions and leaves anything else alone', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpVersion('1.2.3', 'none')).toBe('1.2.3')
    expect(bumpVersion('nightly', 'major')).toBe('nightly')
    expect(bumpVersion(null, 'major')).toBeNull()
  })
})

describe('workspace mission states', () => {
  it('terminal states have no way out, a usage wait never fails a mission, and completion needs verification', () => {
    for (const from of TERMINAL_WORKSPACE_MISSION_STATES) for (const to of WORKSPACE_MISSION_STATES) expect(canTransitionWorkspaceMission(from, to)).toBe(false)
    expect(canTransitionWorkspaceMission('WAITING_FOR_QUOTA', 'FAILED')).toBe(false)
    for (const from of WORKSPACE_MISSION_STATES) expect(canTransitionWorkspaceMission(from, 'COMPLETED'), from).toBe(from === 'VERIFYING')
    expect(canTransitionWorkspaceMission('PLANNING', 'AWAITING_APPROVAL')).toBe(true)
    expect(canTransitionWorkspaceMission('AWAITING_APPROVAL', 'ACTIVE')).toBe(true)
  })
})

describe('manifest discovery', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const repo = (name: string, files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), `nexus-ws-${name}-`))
    dirs.push(root)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }

  it('reads name, version and dependencies from each kind of manifest, and nothing from a repository without one', () => {
    expect(readManifest(repo('js', { 'package.json': JSON.stringify({ name: '@acme/sdk', version: '2.3.0', dependencies: { zod: '^4' }, devDependencies: { vitest: '5' } }, null, 2) }))).toMatchObject({ file: 'package.json', name: '@acme/sdk', version: '2.3.0', dependencies: [expect.objectContaining({ name: 'zod', spec: '^4' }), expect.objectContaining({ name: 'vitest' })] })
    expect(readManifest(repo('rs', { 'Cargo.toml': '[package]\nname = "backend"\nversion = "1.9.0"\n\n[dependencies]\nserde = "1"\nsdk = { path = "../sdk" }\n' }))).toMatchObject({ file: 'Cargo.toml', name: 'backend', version: '1.9.0', dependencies: [{ name: 'serde' }, { name: 'sdk', spec: '{ path = "../sdk" }' }] })
    expect(readManifest(repo('py', { 'pyproject.toml': '[project]\nname = "tools"\nversion = "0.4.1"\ndependencies = [\n  "requests>=2",\n  "acme-sdk",\n]\n' }))).toMatchObject({ file: 'pyproject.toml', name: 'tools', version: '0.4.1', dependencies: [{ name: 'requests', spec: '>=2' }, { name: 'acme-sdk' }] })
    expect(readManifest(repo('go', { 'go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire (\n\texample.com/sdk v1.2.0\n)\n' }))).toMatchObject({ file: 'go.mod', name: 'example.com/svc', version: null, dependencies: [{ name: 'example.com/sdk', spec: 'v1.2.0' }] })
    expect(readManifest(repo('none', { 'README.md': '# docs\n' }))).toBeNull()
    expect(readManifest(repo('bad', { 'package.json': '{ not json' }))).toBeNull()
  })

  it('finds dependencies between enrolled repositories by package name or local path, with the manifest line as provenance', () => {
    const sdk = repo('sdk', { 'package.json': JSON.stringify({ name: '@acme/sdk', version: '2.3.0' }) })
    const backend = repo('backend', { 'package.json': JSON.stringify({ name: 'backend', version: '1.9.0', dependencies: { '@acme/sdk': '^2.3.0', express: '^5' } }, null, 2) })
    const desktop = repo('desktop', { 'package.json': JSON.stringify({ name: 'desktop', version: '0.8.0', dependencies: { api: `file:${backend.replace(/\\/g, '/')}` } }, null, 2) })
    const docs = repo('docs', { 'README.md': '# docs\n' })
    const repositories = [
      { key: 'shared-sdk', rootPath: sdk, manifest: readManifest(sdk) },
      { key: 'backend', rootPath: backend, manifest: readManifest(backend) },
      { key: 'desktop', rootPath: desktop, manifest: readManifest(desktop) },
      { key: 'docs', rootPath: docs, manifest: readManifest(docs) },
    ]
    const edges = discoverManifestEdges(repositories)
    expect(edges.map((e) => [e.from, e.to, e.kind, e.provenance.source])).toEqual([
      ['backend', 'shared-sdk', 'package_dependency', 'manifest'],
      ['desktop', 'backend', 'package_dependency', 'manifest'],
    ])
    expect(edges[0]!.provenance.file).toMatch(/^package\.json:\d+$/)
    expect(edges[0]!.provenance.detail).toContain('@acme/sdk')
    // Dependencies on packages that are not enrolled are not edges.
    expect(edges.some((e) => e.provenance.detail.includes('express'))).toBe(false)
  })
})
