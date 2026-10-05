import { useState } from 'react'
import {
  CONTRACT_KINDS,
  type CompatibilityResult,
  type ContractKind,
  type WorkspaceDetail,
} from '@shared/workspace'
import { useAddConsumer, useCaptureContract, useRegisterContract } from '../../lib/queries-v5'
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  PlusIcon,
  RefreshIcon,
  Select,
  TimeAgo,
} from '../../components/ui'
import { Empty } from '../programs/programsUi'
import {
  buildConsumerInput,
  buildContractInput,
  emptyContractForm,
  validateConsumerForm,
  validateContractForm,
  type ConsumerField,
  type ContractField,
  type ContractForm,
} from './workspaceForm'
import {
  captureText,
  changeRows,
  compatibilityInfo,
  CONTRACT_KIND_LABEL,
  PROVENANCE_LABEL,
  versionRows,
} from './workspacesModel'
import { CompatBadge, H3, Mono, Table, Td, Th } from './workspacesUi'

const KIND_OPTIONS = CONTRACT_KINDS.map((k) => ({ value: k, label: CONTRACT_KIND_LABEL[k] }))

/** A compatibility result: level badge with text and icon, summary, and every change. */
export function CompatibilityPanel({
  result,
  testId,
}: {
  result: CompatibilityResult
  testId: string
}) {
  const info = compatibilityInfo(result.level)
  const rows = changeRows(result.changes)
  return (
    <div
      className="flex flex-col gap-2 rounded-md border bg-surface-muted p-3"
      data-testid={testId}
      data-level={result.level}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CompatBadge level={result.level} testId={`${testId}-level`} />
        <span className="text-small text-text-secondary">{info.meaning}</span>
      </div>
      <p className="m-0" data-testid={`${testId}-summary`}>
        {result.summary}
      </p>
      {rows.length > 0 ? (
        <Table caption="Changes to the contract surface" testId={`${testId}-changes`}>
          <thead>
            <tr>
              <Th>Path</Th>
              <Th>Change</Th>
              <Th>Before → after</Th>
              <Th>Breaking</Th>
              <Th>Why</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.path}-${i}`} data-breaking={c.breaking}>
                <Td className="break-all font-mono text-code">{c.path}</Td>
                <Td>{c.change}</Td>
                <Td className="break-all font-mono text-code">{c.beforeAfter}</Td>
                <Td>
                  <Badge tone={c.breaking ? 'danger' : 'neutral'}>
                    {c.breaking ? 'Yes' : 'No'}
                  </Badge>
                  <span className="sr-only"> {c.breakingLabel}</span>
                </Td>
                <Td>{c.why}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="m-0 text-small text-text-muted">No changes to the surface.</p>
      )}
    </div>
  )
}

function AddConsumer({
  detail,
  contract,
}: {
  detail: WorkspaceDetail
  contract: WorkspaceDetail['contracts'][number]
}) {
  const add = useAddConsumer()
  const [repository, setRepository] = useState('')
  const [copyPath, setCopyPath] = useState('')
  const [touched, setTouched] = useState(false)
  const provider = detail.repositories.find((r) => r.id === contract.providerRepositoryId)
  const taken = [
    provider?.key ?? '',
    ...contract.consumers.map(
      (c) => detail.repositories.find((r) => r.id === c.repositoryId)?.key ?? '',
    ),
  ]
  const form = { repository, copyPath }
  const check = validateConsumerForm(form, taken)
  const err = (f: ConsumerField) => (touched ? check.errors[f] : undefined)
  const key = contract.key
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      aria-label={`Add a consumer of ${contract.name}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (!check.ok) {
          setTouched(true)
          return
        }
        add.mutate(buildConsumerInput(contract.id, form), {
          onSuccess: () => {
            setRepository('')
            setCopyPath('')
            setTouched(false)
          },
        })
      }}
    >
      <Field label="Consumer repository" error={err('repository')} className="min-w-44 flex-1">
        {(id) => (
          <Select
            id={id}
            value={repository}
            onChange={setRepository}
            options={[
              { value: '', label: 'Choose a repository' },
              ...detail.repositories.map((r) => ({ value: r.key, label: r.key })),
            ]}
            data-testid={`contract-consumer-repo-${key}`}
          />
        )}
      </Field>
      <Field
        label="Copy path (optional)"
        hint="Where it keeps its own copy, if it does."
        error={err('copyPath')}
        className="min-w-52 flex-[2]"
      >
        {(id) => (
          <Input
            id={id}
            value={copyPath}
            onChange={(e) => setCopyPath(e.target.value)}
            data-testid={`contract-consumer-copy-${key}`}
          />
        )}
      </Field>
      <Button
        type="submit"
        size="sm"
        icon={<PlusIcon size={12} />}
        loading={add.isPending}
        className="mt-[1.375rem]"
        data-testid={`contract-consumer-add-${key}`}
      >
        Add consumer
      </Button>
      {add.isError ? <ErrorNote error={add.error} className="w-full" /> : null}
    </form>
  )
}

function ContractCard({
  detail,
  contract,
}: {
  detail: WorkspaceDetail
  contract: WorkspaceDetail['contracts'][number]
}) {
  const capture = useCaptureContract()
  const [captured, setCaptured] = useState<{ result: CompatibilityResult; text: string } | null>(
    null,
  )
  const repoKey = (id: string) => detail.repositories.find((r) => r.id === id)?.key ?? id
  const versions = versionRows(contract.versions)
  const key = contract.key
  return (
    <li className="list-none">
      <article
        className="flex flex-col gap-3 rounded-lg border bg-surface p-4"
        data-testid={`contract-${key}`}
      >
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="m-0 flex flex-wrap items-center gap-2 text-heading font-semibold">
              {contract.name}
              <Badge tone="neutral">{CONTRACT_KIND_LABEL[contract.kind]}</Badge>
            </h3>
            <p className="m-0 mt-0.5 text-small text-text-secondary">
              Provided by{' '}
              <span className="font-mono">{repoKey(contract.providerRepositoryId)}</span> at{' '}
              <Mono className="break-all">{contract.path}</Mono>
            </p>
          </div>
          <Button
            size="sm"
            icon={<RefreshIcon size={12} />}
            loading={capture.isPending}
            onClick={() =>
              capture.mutate(
                { contractId: contract.id },
                {
                  onSuccess: (r) =>
                    setCaptured({
                      result: r.result,
                      text: captureText(r.created, r.version.version),
                    }),
                },
              )
            }
            aria-label={`Capture ${contract.name} now`}
            data-testid={`contract-capture-${key}`}
          >
            Capture now
          </Button>
        </header>

        {capture.isError ? <ErrorNote error={capture.error} /> : null}
        {captured ? (
          <div className="flex flex-col gap-1.5" role="status">
            <p
              className="m-0 text-small text-text-secondary"
              data-testid={`contract-captured-${key}`}
            >
              {captured.text}
            </p>
            <CompatibilityPanel result={captured.result} testId={`contract-result-${key}`} />
          </div>
        ) : null}

        <section className="flex flex-col gap-1.5" aria-label={`Consumers of ${contract.name}`}>
          <H3>Consumers</H3>
          {contract.consumers.length === 0 ? (
            <p className="m-0 text-small text-text-muted">No consumers recorded.</p>
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-1 p-0"
              data-testid={`contract-consumers-${key}`}
            >
              {contract.consumers.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-baseline gap-x-2 text-small"
                  data-testid={`contract-consumer-${key}-${repoKey(c.repositoryId)}`}
                >
                  <span className="font-mono font-medium">{repoKey(c.repositoryId)}</span>
                  {c.copyPath ? (
                    <span className="text-text-secondary">
                      copy at <Mono className="break-all">{c.copyPath}</Mono>
                    </span>
                  ) : (
                    <span className="text-text-muted">no copy</span>
                  )}
                  <span className="text-text-muted">· {PROVENANCE_LABEL[c.provenance.source]}</span>
                </li>
              ))}
            </ul>
          )}
          <AddConsumer detail={detail} contract={contract} />
        </section>

        <section className="flex flex-col gap-1.5" aria-label={`Versions of ${contract.name}`}>
          <H3>Versions</H3>
          {versions.length === 0 ? (
            <p
              className="m-0 text-small text-text-muted"
              data-testid={`contract-versions-empty-${key}`}
            >
              Not captured yet. Capture it to record version 1.
            </p>
          ) : (
            <Table
              caption={`Captured versions of ${contract.name}`}
              testId={`contract-versions-${key}`}
            >
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Hash</Th>
                  <Th>Commit</Th>
                  <Th>Captured</Th>
                  <Th>Surface elements</Th>
                  <Th>Parse</Th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <Td className="tnum font-medium">{v.version}</Td>
                    <Td className="font-mono text-code">{v.hash}</Td>
                    <Td className="font-mono text-code">{v.commit}</Td>
                    <Td>
                      <TimeAgo iso={v.capturedAt} />
                    </Td>
                    <Td className="tnum">{v.elements}</Td>
                    <Td>
                      {v.parseError ? (
                        <Badge tone="warning" title={v.parseError}>
                          Could not be read: {v.parseError}
                        </Badge>
                      ) : (
                        <span className="text-text-muted">Read</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </article>
    </li>
  )
}

function RegisterContract({ detail }: { detail: WorkspaceDetail }) {
  const register = useRegisterContract()
  const [form, setForm] = useState<ContractForm>(emptyContractForm)
  const [touched, setTouched] = useState<ReadonlySet<ContractField>>(new Set())
  const check = validateContractForm(
    form,
    detail.contracts.map((c) => c.key),
  )
  const err = (f: ContractField) => (touched.has(f) ? check.errors[f] : undefined)
  const touch = (f: ContractField) => setTouched((t) => new Set(t).add(f))
  const patch = (p: Partial<ContractForm>) => setForm((f) => ({ ...f, ...p }))
  return (
    <Card
      title="Register a contract"
      description="A contract is an interface one repository owns and others rely on: an API description, a schema, a public type surface."
      data-testid="contract-register"
    >
      {detail.repositories.length === 0 ? (
        <p className="m-0 text-small text-text-muted">
          Enroll a repository first: a contract is owned by one of them.
        </p>
      ) : (
        <form
          className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!check.ok) {
              setTouched(new Set<ContractField>(['key', 'name', 'provider', 'path']))
              return
            }
            register.mutate(buildContractInput(detail.workspace.id, form), {
              onSuccess: () => {
                setForm(emptyContractForm())
                setTouched(new Set())
              },
            })
          }}
        >
          <Field label="Key" hint="Lower-case letters, digits and dashes." error={err('key')}>
            {(id) => (
              <Input
                id={id}
                value={form.key}
                onChange={(e) => patch({ key: e.target.value })}
                onBlur={() => touch('key')}
                aria-invalid={!!err('key')}
                data-testid="contract-key"
              />
            )}
          </Field>
          <Field label="Name" error={err('name')}>
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                onBlur={() => touch('name')}
                aria-invalid={!!err('name')}
                data-testid="contract-name"
              />
            )}
          </Field>
          <Field label="Kind">
            {(id) => (
              <Select
                id={id}
                value={form.kind}
                options={KIND_OPTIONS}
                onChange={(kind: ContractKind) => patch({ kind })}
                data-testid="contract-kind"
              />
            )}
          </Field>
          <Field label="Provider repository" error={err('provider')}>
            {(id) => (
              <Select
                id={id}
                value={form.provider}
                onChange={(provider) => patch({ provider })}
                options={[
                  { value: '', label: 'Choose a repository' },
                  ...detail.repositories.map((r) => ({ value: r.key, label: r.key })),
                ]}
                data-testid="contract-provider"
              />
            )}
          </Field>
          <Field
            label="Path in the provider"
            hint="For example openapi/api.json (OpenAPI is read as JSON)"
            error={err('path')}
            className="md:col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                value={form.path}
                onChange={(e) => patch({ path: e.target.value })}
                onBlur={() => touch('path')}
                aria-invalid={!!err('path')}
                data-testid="contract-path"
              />
            )}
          </Field>
          <div className="flex items-center gap-2 md:col-span-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<PlusIcon size={12} />}
              loading={register.isPending}
              data-testid="contract-register-submit"
            >
              Register contract
            </Button>
            {check.reason && touched.size > 0 ? (
              <span className="text-small text-warning" role="status">
                {check.reason}
              </span>
            ) : null}
          </div>
          {register.isError ? <ErrorNote error={register.error} className="md:col-span-2" /> : null}
        </form>
      )}
    </Card>
  )
}

export function ContractsTab({ detail }: { detail: WorkspaceDetail }) {
  return (
    <div className="flex flex-col gap-4" data-testid="workspace-contracts">
      <p className="m-0 max-w-prose text-small text-text-secondary">
        Capturing a contract reads its file at the provider&rsquo;s current commit, records a
        version and compares it with the previous one from the consumers&rsquo; side.
      </p>
      {detail.contracts.length === 0 ? (
        <Empty testId="workspace-contracts-empty">
          No contracts yet. Register the first one below.
        </Empty>
      ) : (
        <ul className="m-0 flex flex-col gap-3 p-0" aria-label="Contracts">
          {detail.contracts.map((c) => (
            <ContractCard key={c.id} detail={detail} contract={c} />
          ))}
        </ul>
      )}
      <RegisterContract detail={detail} />
    </div>
  )
}
