import { useState } from 'react'
import { useCreateWorkspace } from '../../lib/queries-v5'
import { Button, Dialog, ErrorNote, Field, Input, Textarea } from '../../components/ui'
import {
  buildWorkspaceInput,
  emptyWorkspaceForm,
  LIMITS,
  validateWorkspaceForm,
  type WorkspaceField,
} from './workspaceForm'

export function NewWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (workspaceId: string) => void
}) {
  const create = useCreateWorkspace()
  const [form, setForm] = useState(emptyWorkspaceForm)
  const [touched, setTouched] = useState<ReadonlySet<WorkspaceField>>(new Set())
  const check = validateWorkspaceForm(form)
  const err = (f: WorkspaceField) => (touched.has(f) ? check.errors[f] : undefined)
  const touch = (f: WorkspaceField) => setTouched((t) => new Set(t).add(f))
  const submit = () => {
    if (!check.ok) {
      setTouched(new Set<WorkspaceField>(['name', 'description']))
      return
    }
    create.mutate(buildWorkspaceInput(form), {
      onSuccess: (w) => {
        setForm(emptyWorkspaceForm())
        setTouched(new Set())
        onClose()
        onCreated(w.id)
      },
    })
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New workspace"
      width={560}
      testId="workspace-dialog"
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center" role="status">
            {check.reason && touched.size > 0 ? (
              <span className="text-small text-warning">{check.reason}</span>
            ) : null}
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!check.ok}
            loading={create.isPending}
            onClick={submit}
            data-testid="workspace-create"
          >
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="m-0 text-small text-text-secondary">
          A workspace groups the repositories that one goal can change together. You enroll the
          repositories after creating it.
        </p>
        <Field label="Name" error={err('name')}>
          {(id) => (
            <Input
              id={id}
              value={form.name}
              maxLength={LIMITS.workspaceName + 20}
              placeholder="RaceDeck Platform"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={() => touch('name')}
              aria-invalid={!!err('name')}
              data-testid="workspace-name"
            />
          )}
        </Field>
        <Field
          label="Description"
          hint="Optional. What these repositories make together."
          error={err('description')}
        >
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              onBlur={() => touch('description')}
              data-testid="workspace-description"
            />
          )}
        </Field>
        {create.isError ? <ErrorNote error={create.error} /> : null}
      </form>
    </Dialog>
  )
}
