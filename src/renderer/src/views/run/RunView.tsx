import { useCallback, useEffect, useState } from 'react'
import { ErrorNote, Loading, Tabs, type TabItem } from '../../components/ui'
import { PanelGroup, ResizablePanel, ResizeHandle } from '../../components/ui/Resizable'
import { useRunDetail } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { ErrorBoundary } from '../../app/ErrorBoundary'
import { TaskGraph } from './graph/TaskGraph'
import { TaskInspector } from './inspector/TaskInspector'
import { MissionHeader } from './MissionHeader'
import { PlanPanel, PlannerActivity } from './PlanPanel'
import { RunsList } from './RunsList'
import { RunProvider, useEventStream, useRunCtx, type BottomTab, type StageView } from './runContext'
import { MissionComplete, RunStatePanel } from './StatePanels'
import {
  CommunicationsTab,
  DecisionsTab,
  MissionCriteriaTab,
  ReviewsTab,
  RunDiffTab,
  ToolActivityTab,
  VerificationsTab,
} from './tabs/RunTabs'
import { Timeline } from './tabs/Timeline'

const BOTTOM_ITEMS: readonly TabItem<BottomTab>[] = (
  [
    ['timeline', 'Timeline'],
    ['communications', 'Communications'],
    ['tools', 'Tool activity'],
    ['diff', 'Run diff'],
    ['reviews', 'Reviews'],
    ['verification', 'Verification'],
    ['decisions', 'Decisions'],
    ['criteria', 'Mission criteria'],
  ] as const
).map(([id, label]) => ({ id, label, testId: `bottom-tab-${id}` }))

const STAGE_ITEMS: readonly TabItem<StageView>[] = [
  { id: 'overview', label: 'Overview', testId: 'stage-tab-overview' },
  { id: 'graph', label: 'Task graph', testId: 'stage-tab-graph' },
]

function Stage({ choice, onChoose }: { choice: StageView | null; onChoose: (v: StageView) => void }) {
  const { detail } = useRunCtx()
  const state = detail.run.state
  const hasOverview = state === 'planning' || state === 'awaiting_approval' || state === 'completed'
  const view: StageView = hasOverview ? (choice ?? 'overview') : 'graph'
  const selectedTaskId = useUiStore((s) => s.taskId)
  const selectTask = useUiStore((s) => s.selectTask)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-stage" data-stage={view}>
      {hasOverview ? <Tabs tabs={STAGE_ITEMS} active={view} onChange={onChoose} className="bg-surface-1 px-1" /> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'overview' ? (
          state === 'planning' ? (
            <PlannerActivity />
          ) : state === 'awaiting_approval' ? (
            <PlanPanel />
          ) : (
            <MissionComplete />
          )
        ) : (
          <>
            <RunStatePanel />
            <div className="min-h-0 flex-1">
              <TaskGraph selectedTaskId={selectedTaskId} onSelect={selectTask} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function BottomPanel({ tab, onTab, events }: { tab: BottomTab; onTab: (t: BottomTab) => void; events: { loading: boolean; error: unknown } }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <Tabs tabs={BOTTOM_ITEMS} active={tab} onChange={onTab} className="overflow-x-auto px-1" />
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'timeline' ? <Timeline loading={events.loading} error={events.error} /> : null}
        {tab === 'communications' ? <CommunicationsTab /> : null}
        {tab === 'tools' ? <ToolActivityTab /> : null}
        {tab === 'diff' ? <RunDiffTab /> : null}
        {tab === 'reviews' ? <ReviewsTab /> : null}
        {tab === 'verification' ? <VerificationsTab /> : null}
        {tab === 'decisions' ? <DecisionsTab /> : null}
        {tab === 'criteria' ? <MissionCriteriaTab /> : null}
      </div>
    </div>
  )
}

function Inspector() {
  const { tasksById } = useRunCtx()
  const taskId = useUiStore((s) => s.taskId)
  return <TaskInspector task={taskId ? (tasksById.get(taskId) ?? null) : null} />
}

function RunWorkspace({ runId }: { runId: string }) {
  const query = useRunDetail(runId)
  const stream = useEventStream(runId)
  const [stageChoice, setStageChoice] = useState<StageView | null>(null)
  const [bottom, setBottom] = useState<BottomTab>('timeline')
  const state = query.data?.run.state

  // A state change (planning → approval → executing → completed) returns the stage to its natural view.
  useEffect(() => setStageChoice(null), [state])

  const showStage = useCallback((v: StageView) => setStageChoice(v), [])
  const showBottom = useCallback((t: BottomTab) => setBottom(t), [])

  if (query.isPending) return <Loading label="Loading run" />
  if (query.isError) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <ErrorNote error={query.error} />
        <button type="button" className="self-start text-accent hover:underline" onClick={() => useUiStore.setState({ runId: null, taskId: null })}>
          Back to runs
        </button>
      </div>
    )
  }

  return (
    <RunProvider detail={query.data} events={stream.events} showStage={showStage} showBottom={showBottom}>
      <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
        <MissionHeader />
        <div className="min-h-0 flex-1">
          <PanelGroup id="run-main">
            <ResizablePanel id="run-center" minSize="35%">
              <PanelGroup id="run-center-split" orientation="vertical">
                <ResizablePanel id="run-stage" minSize="180px">
                  <ErrorBoundary label="Run stage failed" resetKey={runId}>
                    <Stage choice={stageChoice} onChoose={setStageChoice} />
                  </ErrorBoundary>
                </ResizablePanel>
                <ResizeHandle orientation="vertical" />
                <ResizablePanel id="run-bottom" defaultSize="34%" minSize="120px">
                  <ErrorBoundary label="Run tabs failed" resetKey={bottom}>
                    <BottomPanel tab={bottom} onTab={setBottom} events={stream} />
                  </ErrorBoundary>
                </ResizablePanel>
              </PanelGroup>
            </ResizablePanel>
            <ResizeHandle />
            <ResizablePanel id="run-inspector" defaultSize="440px" minSize="320px" maxSize="760px">
              <ErrorBoundary label="Inspector failed">
                <Inspector />
              </ErrorBoundary>
            </ResizablePanel>
          </PanelGroup>
        </div>
      </div>
    </RunProvider>
  )
}

export function RunView() {
  const runId = useUiStore((s) => s.runId)
  if (!runId) return <RunsList />
  // Keyed by run so event cursors, tab choices and the selected stage never leak between runs.
  return <RunWorkspace key={runId} runId={runId} />
}
