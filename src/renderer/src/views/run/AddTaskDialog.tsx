import { useState } from 'react'
import type { CompilationMode, CompiledTaskSpec } from '@shared/intelligence'
import { CompilationPreview } from '../projects/CompilationPreview'
import { AGENT_ROLES, COMPLEXITIES } from '@shared/domain'
import { Button, Dialog, ErrorNote, Field, Input, Select, Textarea } from '../../components/ui'
import { useAddTask } from '../../lib/queries'
import { EMPTY_ADD_TASK as EMPTY, lines, validateAddTask, type AddTaskForm } from './addTaskForm'
import { useRunCtx } from './runContext'

export function AddTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { detail } = useRunCtx()
  const add = useAddTask()
  const [form, setForm] = useState<AddTaskForm>(EMPTY)
  const [touched, setTouched] = useState(false)
  const [compilationMode, setCompilationMode] = useState<CompilationMode>('AUTO')
  const [spec, setSpec] = useState<CompiledTaskSpec | null>(null)
  const errors = validateAddTask(form)
  const set = <K extends keyof AddTaskForm>(key: K, value: AddTaskForm[K]) => {
    setSpec(null)
    setForm((f) => ({ ...f, [key]: value }))
  }

  const close = () => {
    setForm(EMPTY)
    setTouched(false)
    setSpec(null)
    onClose()
  }

  const submit = () => {
    setTouched(true)
    if (Object.keys(errors).length > 0) return
    add.mutate(
      {
        runId: detail.run.id,
        title: form.title.trim(),
        description: form.description,
        role: form.role,
        dependsOn: form.dependsOn,
        suggestedFiles: lines(form.suggestedFiles),
        acceptanceCriteria: lines(form.criteria),
        complexity: form.complexity,
        compilationMode,
        ...(spec ? { compiledSpecId: spec.id } : {}),
      },
      { onSuccess: close },
    )
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add task"
      width={560}
      testId="add-task-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} onClick={submit} data-testid="add-task-submit">
            Add task
          </Button>
        </>
      }
    >
      <fieldset disabled={add.isPending} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <Field label="Title" error={touched ? errors.title : undefined}>
          {(id) => <Input id={id} value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} data-testid="add-task-title" />}
        </Field>
        <Field label="Description" error={touched ? errors.description : undefined}>
          {(id) => <Textarea id={id} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} data-testid="add-task-description" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            {(id) => (
              <Select id={id} value={form.role} onChange={(v) => set('role', v)} options={AGENT_ROLES.map((r) => ({ value: r, label: r }))} data-testid="add-task-role" />
            )}
          </Field>
          <Field label="Complexity">
            {(id) => (
              <Select id={id} value={form.complexity} onChange={(v) => set('complexity', v)} options={COMPLEXITIES.map((c) => ({ value: c, label: c }))} data-testid="add-task-complexity" />
            )}
          </Field>
        </div>
        <fieldset className="m-0 flex flex-col gap-1 border p-2">
          <legend className="px-1 text-[0.85rem] font-medium text-text-secondary">Depends on</legend>
          {detail.tasks.length === 0 ? (
            <div className="text-text-muted">No existing tasks.</div>
          ) : (
            <div className="flex max-h-32 flex-col gap-0.5 overflow-auto" data-testid="add-task-deps">
              {detail.tasks.map((t) => (
                <label key={t.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.dependsOn.includes(t.id)}
                    onChange={(e) => set('dependsOn', e.target.checked ? [...form.dependsOn, t.id] : form.dependsOn.filter((d) => d !== t.id))}
                  />
                  <span className="truncate">{t.title}</span>
                  <span className="font-mono text-small text-text-muted">{t.key}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <Field label="Suggested files" hint="One path per line.">
          {(id) => <Textarea id={id} rows={2} value={form.suggestedFiles} onChange={(e) => set('suggestedFiles', e.target.value)} className="font-mono" />}
        </Field>
        <Field label="Acceptance criteria" hint="One criterion per line.">
          {(id) => <Textarea id={id} rows={3} value={form.criteria} onChange={(e) => set('criteria', e.target.value)} data-testid="add-task-criteria" />}
        </Field>
        <CompilationPreview
          projectId={detail.run.projectId}
          raw={form.description}
          executionScope={{ runId: detail.run.id }}
          metadata={{
            entryPoint: 'TASK_ADDITION',
            goals: [form.title.trim(), form.description],
            constraints: [],
        acceptanceCriteria: lines(form.criteria),
          }}
          mode={compilationMode}
          onModeChange={(mode) => {
            setCompilationMode(mode)
            setSpec(null)
          }}
          spec={spec}
          onSpec={setSpec}
        />
        {add.isError ? <ErrorNote error={add.error} /> : null}
      </fieldset>
    </Dialog>
  )
}
