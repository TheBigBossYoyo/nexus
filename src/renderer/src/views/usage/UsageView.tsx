import { EmptyState, PageHeader, UsageIcon } from '../../components/ui'

/** Placeholder until the Usage dashboard lands. */
export function UsageView() {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="usage-view">
      <PageHeader title="Usage" context="Intelligence" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <EmptyState icon={<UsageIcon size={20} />} title="Usage dashboard">
          NEXUS can measure its own observed Claude usage, but this Claude runtime does not expose
          total subscription capacity.
        </EmptyState>
      </div>
    </div>
  )
}
