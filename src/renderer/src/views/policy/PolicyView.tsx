import { EmptyState, PageHeader, PolicyIcon } from '../../components/ui'

/** Placeholder until the Policy page lands. */
export function PolicyView() {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="policy-view">
      <PageHeader title="Policy" context="Intelligence" />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <EmptyState icon={<PolicyIcon size={20} />} title="The default policy is active">
          NEXUS chooses an orchestration strategy by rule until Arena trials and real missions give
          it evidence to prefer another.
        </EmptyState>
      </div>
    </div>
  )
}
