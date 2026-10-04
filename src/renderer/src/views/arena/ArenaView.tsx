import { useMemo, useState } from 'react'
import { useArenaCampaigns, useArenaResults, useImportCase } from '../../lib/queries-v3'
import { useNow } from '../../lib/useNow'
import { ArenaIcon, Button, Card, EmptyState, PageHeader, PlusIcon } from '../../components/ui'
import { BlockSkeleton, LoadMore, ReadError } from '../usage/shared'
import { CampaignTable } from './CampaignList'
import { CampaignPage } from './CampaignPage'
import { ComparisonTable } from './ComparisonTable'
import { NewCampaignDialog } from './NewCampaignDialog'

function Recent() {
  const q = useArenaResults(null)
  if (q.isPending || q.isError || q.data.comparison.length === 0) return null
  return (
    <Card
      title="Recent results"
      description="Controlled trials across all campaigns. Arena is a controlled experiment; the policy also weighs observational mission history separately."
      data-testid="arena-recent-results"
    >
      <div className="flex flex-col gap-2">
        <ComparisonTable rows={q.data.comparison} />
        {q.data.notes.length > 0 ? (
          <ul className="m-0 list-none p-0 text-small text-text-secondary">
            {q.data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  )
}

/** Arena: controlled experiments that compare orchestration strategies. A campaign opens in place of the list. */
export function ArenaView() {
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const campaigns = useArenaCampaigns()
  const importCase = useImportCase()
  const now = useNow(true, 30_000)
  const rows = useMemo(
    () => campaigns.data?.pages.flatMap((p) => p.campaigns) ?? [],
    [campaigns.data],
  )
  const total = campaigns.data?.pages[0]?.total ?? 0

  if (campaignId)
    return (
      <>
        <div className="h-full" data-testid="arena-view">
          <CampaignPage campaignId={campaignId} onBack={() => setCampaignId(null)} />
        </div>
      </>
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="arena-view">
      <PageHeader
        title="Arena"
        context="Intelligence"
        actions={
          <>
            <Button
              size="sm"
              loading={importCase.isPending}
              onClick={() => importCase.mutate({})}
              data-testid="arena-import-case-header"
            >
              Import case…
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<PlusIcon size={12} />}
              onClick={() => setDialog(true)}
              data-testid="arena-new-campaign"
            >
              New campaign
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-5">
          <p className="m-0 text-small text-text-muted">
            Arena: controlled experiment · Mission history: observational evidence
          </p>
          {campaigns.isPending ? (
            <BlockSkeleton rows={4} testId="arena-loading" />
          ) : campaigns.isError ? (
            <ReadError
              error={campaigns.error}
              calm="Arena is not available in this build yet."
              onRetry={() => void campaigns.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ArenaIcon size={20} />}
              title="No Arena campaigns yet"
              className="py-16"
              data-testid="arena-empty"
              action={
                <Button
                  variant="primary"
                  onClick={() => setDialog(true)}
                  data-testid="arena-create-campaign"
                >
                  Create campaign
                </Button>
              }
            >
              Compare orchestration strategies on controlled engineering tasks.
            </EmptyState>
          ) : (
            <>
              <section className="flex flex-col gap-2" aria-label="Campaigns">
                <div className="flex items-end justify-between">
                  <h2 className="m-0 text-heading font-semibold">Campaigns</h2>
                  <span className="tnum text-small text-text-muted">{total} total</span>
                </div>
                <CampaignTable rows={rows} onOpen={setCampaignId} now={now} />
                {campaigns.hasNextPage ? (
                  <LoadMore
                    onClick={() => void campaigns.fetchNextPage()}
                    loading={campaigns.isFetchingNextPage}
                    children="Load more"
                  />
                ) : null}
              </section>
              <Recent />
            </>
          )}
        </div>
      </div>
      <NewCampaignDialog open={dialog} onClose={() => setDialog(false)} onCreated={setCampaignId} />
    </div>
  )
}
