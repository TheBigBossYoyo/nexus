import { ArenaIcon, EmptyState, PageHeader } from '../../components/ui'

/** Placeholder until the Arena page lands. */
export function ArenaView() {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="arena-view">
      <PageHeader title="Arena" context="Intelligence" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <EmptyState icon={<ArenaIcon size={20} />} title="No Arena campaigns yet">
          Compare orchestration strategies on controlled engineering tasks.
        </EmptyState>
      </div>
    </div>
  )
}
