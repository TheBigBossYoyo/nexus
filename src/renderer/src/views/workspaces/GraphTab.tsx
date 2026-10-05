import { useId, useState } from 'react'
import { DEPENDENCY_KINDS, type DependencyKind, type WorkspaceDetail } from '@shared/workspace'
import {
  useAddDependency,
  useDiscoverDependencies,
  useRemoveDependency,
} from '../../lib/queries-v5'
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Notice,
  PlusIcon,
  Select,
  SearchIcon,
} from '../../components/ui'
import { Empty } from '../programs/programsUi'
import {
  buildDependencyInput,
  emptyDependencyForm,
  validateDependencyForm,
  type DependencyField,
} from './workspaceForm'
import {
  DEPENDENCY_KIND_LABEL,
  edgeRows,
  graphLayout,
  graphSummary,
  linePath,
  NODE_H,
  NODE_W,
  ROLE_LABEL,
} from './workspacesModel'
import { Table, Td, Th } from './workspacesUi'

const KIND_OPTIONS = DEPENDENCY_KINDS.map((k) => ({ value: k, label: DEPENDENCY_KIND_LABEL[k] }))

/** The picture. Providers on the left, consumers to the right; the table below says everything the picture shows. */
function GraphPicture({ detail }: { detail: WorkspaceDetail }) {
  const layout = graphLayout(detail)
  const markerId = useId()
  const roleOf = new Map(detail.repositories.map((r) => [r.key, r.role]))
  if (!layout.ok) {
    return (
      <Notice tone="danger" title="Dependency cycle" data-testid="graph-cycle">
        These repositories depend on each other in a cycle, so there is no order in which to change
        or release them: <strong data-testid="graph-cycle-list">{layout.cycle.join(', ')}</strong>.
        Remove one of the dependencies below to break the cycle.
      </Notice>
    )
  }
  if (layout.nodes.length === 0)
    return (
      <Empty testId="graph-empty">Enroll repositories to see how they depend on each other.</Empty>
    )
  return (
    <figure className="m-0 flex flex-col gap-2" data-testid="graph-figure">
      <div className="overflow-x-auto rounded-lg border bg-surface p-2">
        <svg
          role="img"
          aria-label={`Repository dependency graph. ${graphSummary(detail)} The table below lists every dependency.`}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="mx-auto block max-w-none text-text-muted"
          data-testid="graph-svg"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.lines.map((l, i) => (
            <path
              key={`${l.from}-${l.to}-${i}`}
              d={linePath(l)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray={l.source === 'user' ? '5 3' : undefined}
              markerEnd={`url(#${markerId})`}
              data-edge={`${l.from}>${l.to}`}
            />
          ))}
          {layout.nodes.map((n) => (
            <g key={n.key} data-testid={`graph-node-${n.key}`} data-level={n.level}>
              <rect
                x={n.x}
                y={n.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className="fill-surface stroke-border-strong"
                strokeWidth={1}
              />
              <text
                x={n.x + 10}
                y={n.y + 19}
                className="fill-text-primary"
                fontSize={13}
                fontWeight={600}
                fontFamily="var(--font-mono, monospace)"
              >
                {n.key.length > 18 ? `${n.key.slice(0, 17)}…` : n.key}
              </text>
              <text x={n.x + 10} y={n.y + 35} className="fill-text-muted" fontSize={11}>
                {ROLE_LABEL[roleOf.get(n.key) ?? 'other']} · level {n.level + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="text-small text-text-secondary">
        Providers are on the left and the repositories that depend on them are to the right. An
        arrow points from a repository to the repository it depends on; a dashed line is a
        dependency you added yourself.
        <span className="sr-only"> {graphSummary(detail)}</span>
      </figcaption>
    </figure>
  )
}

function AddDependency({ detail }: { detail: WorkspaceDetail }) {
  const add = useAddDependency()
  const [form, setForm] = useState(emptyDependencyForm)
  const [touched, setTouched] = useState<ReadonlySet<DependencyField>>(new Set())
  const rows = edgeRows(detail)
  const check = validateDependencyForm(form, rows)
  const err = (f: DependencyField) => (touched.has(f) ? check.errors[f] : undefined)
  const keys = detail.repositories.map((r) => ({ value: r.key, label: r.key }))
  const options = (placeholder: string) => [{ value: '', label: placeholder }, ...keys]
  const submit = () => {
    if (!check.ok) {
      setTouched(new Set<DependencyField>(['from', 'to', 'detail']))
      return
    }
    add.mutate(buildDependencyInput(detail.workspace.id, form), {
      onSuccess: () => {
        setForm(emptyDependencyForm())
        setTouched(new Set())
      },
    })
  }
  return (
    <Card
      title="Add a dependency"
      description="Record a dependency that the manifests do not show. It is kept as one you added, with your reason."
      data-testid="dependency-form"
    >
      {detail.repositories.length < 2 ? (
        <p className="m-0 text-small text-text-muted">
          Enroll at least two repositories to record a dependency between them.
        </p>
      ) : (
        <form
          className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Field label="From (the dependent)" error={err('from')}>
            {(id) => (
              <Select
                id={id}
                value={form.from}
                options={options('Choose a repository')}
                onChange={(from) => setForm((f) => ({ ...f, from }))}
                data-testid="dependency-from"
              />
            )}
          </Field>
          <Field label="To (what it depends on)" error={err('to')}>
            {(id) => (
              <Select
                id={id}
                value={form.to}
                options={options('Choose a repository')}
                onChange={(to) => setForm((f) => ({ ...f, to }))}
                data-testid="dependency-to"
              />
            )}
          </Field>
          <Field label="Kind">
            {(id) => (
              <Select
                id={id}
                value={form.kind}
                options={KIND_OPTIONS}
                onChange={(kind: DependencyKind) => setForm((f) => ({ ...f, kind }))}
                data-testid="dependency-kind"
              />
            )}
          </Field>
          <Field label="Reason" hint="Required. Why does it depend on it?" error={err('detail')}>
            {(id) => (
              <Input
                id={id}
                value={form.detail}
                onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
                onBlur={() => setTouched((t) => new Set(t).add('detail'))}
                aria-invalid={!!err('detail')}
                data-testid="dependency-detail"
              />
            )}
          </Field>
          <div className="flex items-center gap-2 md:col-span-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<PlusIcon size={12} />}
              loading={add.isPending}
              data-testid="dependency-add"
            >
              Add dependency
            </Button>
            {check.reason && touched.size > 0 ? (
              <span className="text-small text-warning" role="status">
                {check.reason}
              </span>
            ) : null}
          </div>
          {add.isError ? <ErrorNote error={add.error} className="md:col-span-2" /> : null}
        </form>
      )}
    </Card>
  )
}

export function GraphTab({ detail }: { detail: WorkspaceDetail }) {
  const discover = useDiscoverDependencies()
  const remove = useRemoveDependency()
  const rows = edgeRows(detail)
  const [found, setFound] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-4" data-testid="workspace-graph">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-prose text-small text-text-secondary">
          How the repositories depend on each other. A repository is changed and released after the
          ones it depends on, so providers come first.
        </p>
        <Button
          size="sm"
          icon={<SearchIcon size={12} />}
          loading={discover.isPending}
          disabled={detail.repositories.length < 2}
          onClick={() =>
            discover.mutate(
              { workspaceId: detail.workspace.id },
              { onSuccess: (r) => setFound(r.length) },
            )
          }
          data-testid="workspace-discover"
        >
          Discover from manifests
        </Button>
      </div>
      {found !== null ? (
        <p
          className="m-0 text-small text-text-secondary"
          role="status"
          data-testid="workspace-discover-result"
        >
          {found === 0
            ? 'The manifests show no new dependencies.'
            : `Discovery finished: ${found} ${found === 1 ? 'dependency' : 'dependencies'} found.`}
        </p>
      ) : null}
      {discover.isError ? <ErrorNote error={discover.error} /> : null}

      <GraphPicture detail={detail} />

      <section className="flex flex-col gap-2" aria-label="All dependencies">
        <h3 className="m-0 text-heading font-semibold">All dependencies</h3>
        {rows.length === 0 ? (
          <Empty testId="workspace-edges-empty">
            No dependencies recorded. Discover them from the manifests, or add one yourself.
          </Empty>
        ) : (
          <Table
            caption="Every dependency between repositories, with where it comes from"
            testId="workspace-edges"
          >
            <thead>
              <tr>
                <Th>From (dependent)</Th>
                <Th>Depends on</Th>
                <Th>Kind</Th>
                <Th>Source</Th>
                <Th>Detail</Th>
                <Th>File</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`edge-${r.id}`} data-source={r.source}>
                  <Td className="font-mono text-code">{r.from}</Td>
                  <Td className="font-mono text-code">{r.to}</Td>
                  <Td>{r.kind}</Td>
                  <Td>{r.sourceLabel}</Td>
                  <Td className="max-w-72 break-words">{r.detail}</Td>
                  <Td className="break-all font-mono text-code">{r.file}</Td>
                  <Td>
                    {r.removable ? (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={remove.isPending && remove.variables?.dependencyId === r.id}
                        onClick={() => remove.mutate({ dependencyId: r.id })}
                        aria-label={`Remove the dependency of ${r.from} on ${r.to}`}
                        data-testid={`dependency-remove-${r.id}`}
                      >
                        Remove
                      </Button>
                    ) : (
                      <span className="text-text-muted">Derived</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {remove.isError ? <ErrorNote error={remove.error} /> : null}
      </section>

      <AddDependency detail={detail} />
    </div>
  )
}
