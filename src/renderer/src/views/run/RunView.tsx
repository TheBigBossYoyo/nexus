import { useCallback, useEffect, useState } from 'react'
import { ErrorNote, IconButton, ChevronDownIcon, ChevronUpIcon, Loading, PageHeader, SegmentedControl, Tabs, type TabItem } from '../../components/ui'
import { PanelGroup, ResizablePanel, ResizeHandle } from '../../components/ui/Resizable'
import { usePanelRef } from 'react-resizable-panels'
import { useRunDetail } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { ErrorBoundary } from '../../app/ErrorBoundary'
import { TaskGraph } from './graph/TaskGraph'
import { TaskList } from './graph/TaskList'
import { TaskInspector } from './inspector/TaskInspector'
import { MissionHeader } from './MissionHeader'
import { OvernightBanner } from './OvernightBanner'
import { PlanInspector } from './PlanInspector'
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
import { AgentActivityTab } from './tabs/AgentActivity'
import { Timeline } from './tabs/Timeline'
import { RunUsageTab } from './tabs/UsageTab'

const BOTTOM_ITEMS: readonly TabItem<BottomTab>[] = (
  [
    ['agents', 'Agents'],
    ['timeline', 'Timeline'],
    ['communications', 'Messages'],
    ['tools', 'Tools'],
    ['diff', 'Diff'],
    ['reviews', 'Reviews'],
    ['verification', 'Verification'],
    ['decisions', 'Decisions'],
    ['criteria', 'Criteria'],
    ['usage', 'Usage'],
  ] as const
).map(([id, label]) => ({ id, label, testId: `bottom-tab-${id}` }))

const OVERVIEW_ITEM: TabItem<StageView> = { id: 'overview', label: 'Overview', testId: 'stage-tab-overview' }
const GRAPH_ITEM: TabItem<StageView> = { id: 'graph', label: 'Graph', testId: 'stage-tab-graph' }
const PLAN_ITEM: TabItem<StageView> = { id: 'plan', label: 'Plan', testId: 'stage-tab-plan' }

type GraphMode = 'graph' | 'list'

function Stage({ choice, onChoose }: { choice: StageView | null; onChoose: (v: StageView) => void }) {
  const { detail } = useRunCtx()
  const state = detail.run.state
  const hasOverview = state === 'planning' || state === 'awaiting_approval' || state === 'completed'
  const view: StageView = choice === 'plan' ? 'plan' : hasOverview ? (choice ?? 'overview') : 'graph'
  const stageItems = hasOverview ? [OVERVIEW_ITEM, GRAPH_ITEM, PLAN_ITEM] : [GRAPH_ITEM, PLAN_ITEM]
  const selectedTaskId = useUiStore((s) => s.taskId)
  const selectTask = useUiStore((s) => s.selectTask)
  const [mode, setMode] = useState<GraphMode>('graph')

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="run-stage" data-stage={view}>
      <div className="flex shrink-0 items-stretch">
        <Tabs tabs={stageItems} active={view} onChange={onChoose} label="Mission stage" className="flex-1 px-3" />
        {view === 'graph' ? (
          <div className="flex items-center border-b pr-3">
          <SegmentedControl
            size="sm"
            label="Task view"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'graph', label: 'Graph', testId: 'graph-mode-graph' },
              { value: 'list', label: 'List', testId: 'graph-mode-list' },
            ]}
          />
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'plan' ? (
          <PlanInspector />
        ) : view === 'overview' ? (
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
            <div className="min-h-0 flex-1 bg-background">
              {mode === 'list' ? (
                <div className="h-full bg-surface">
                  <TaskList selectedTaskId={selectedTaskId} onSelect={selectTask} />
                </div>
              ) : (
                <TaskGraph selectedTaskId={selectedTaskId} onSelect={selectTask} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function BottomPanel({
  tab,
  onTab,
  events,
  collapsed,
  onToggle,
}: {
  tab: BottomTab
  onTab: (t: BottomTab) => void
  events: { loading: boolean; error: unknown }
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="run-bottom" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="flex shrink-0 items-stretch">
        <Tabs tabs={BOTTOM_ITEMS} active={tab} onChange={onTab} label="Mission activity" className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-3 [&::-webkit-scrollbar]:h-1" />
        <div className="flex items-center border-b pr-2">
        <IconButton
          label={collapsed ? 'Expand activity panel' : 'Collapse activity panel'}
          size="sm"
          onClick={onToggle}
          data-testid="bottom-toggle"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'agents' ? <AgentActivityTab /> : null}
        {tab === 'timeline' ? <Timeline loading={events.loading} error={events.error} /> : null}
        {tab === 'communications' ? <CommunicationsTab /> : null}
        {tab === 'tools' ? <ToolActivityTab /> : null}
        {tab === 'diff' ? <RunDiffTab /> : null}
        {tab === 'reviews' ? <ReviewsTab /> : null}
        {tab === 'verification' ? <VerificationsTab /> : null}
        {tab === 'decisions' ? <DecisionsTab /> : null}
        {tab === 'criteria' ? <MissionCriteriaTab /> : null}
        {tab === 'usage' ? <RunUsageTab /> : null}
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
  const [bottom, setBottom] = useState<BottomTab>('agents')
  const [collapsed, setCollapsed] = useState(false)
  const bottomRef = usePanelRef()
  const state = query.data?.run.state

  // A state change (planning → approval → executing → completed) returns the stage to its natural view.
  useEffect(() => setStageChoice(null), [state])

  const showStage = useCallback((v: StageView) => setStageChoice(v), [])
  const showBottom = useCallback(
    (t: BottomTab) => {
      setBottom(t)
      if (bottomRef.current?.isCollapsed()) bottomRef.current.expand()
    },
    [bottomRef],
  )
  const toggleBottom = useCallback(() => {
    const p = bottomRef.current
    if (!p) return
    if (p.isCollapsed()) p.expand()
    else p.collapse()
  }, [bottomRef])

  if (query.isPending) return <Loading label="Loading mission" />
  if (query.isError) {
    return (
      <div className="flex h-full flex-col" data-testid="run-view">
        <PageHeader title="Mission unavailable" context="Missions" />
        <div className="flex flex-col gap-2 p-5">
          <ErrorNote error={query.error} />
          <button type="button" className="self-start text-accent hover:underline" onClick={() => useUiStore.setState({ runId: null, taskId: null })}>
            Back to missions
          </button>
        </div>
      </div>
    )
  }

  return (
    <RunProvider detail={query.data} events={stream.events} showStage={showStage} showBottom={showBottom}>
      <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
        <MissionHeader />
        <OvernightBanner runId={runId} />
        <div className="min-h-0 flex-1">
          <PanelGroup id="run-main">
            <ResizablePanel id="run-center" minSize="35%">
              <PanelGroup id="run-center-split" orientation="vertical">
                <ResizablePanel id="run-stage" minSize="180px">
                  <ErrorBoundary label="Mission stage failed" resetKey={runId}>
                    <Stage choice={stageChoice} onChoose={setStageChoice} />
                  </ErrorBoundary>
                </ResizablePanel>
                <ResizeHandle orientation="vertical" />
                <ResizablePanel
                  id="run-bottom"
                  defaultSize="32%"
                  minSize="120px"
                  collapsible
                  collapsedSize="34px"
                  panelRef={bottomRef}
                  onResize={() => setCollapsed(bottomRef.current?.isCollapsed() ?? false)}
                >
                  <ErrorBoundary label="Activity panel failed" resetKey={bottom}>
                    <BottomPanel
                      tab={bottom}
                      onTab={(t) => showBottom(t)}
                      events={stream}
                      collapsed={collapsed}
                      onToggle={toggleBottom}
                    />
                  </ErrorBoundary>
                </ResizablePanel>
              </PanelGroup>
            </ResizablePanel>
            <ResizeHandle />
            <ResizablePanel id="run-inspector" defaultSize="40%" minSize="320px" maxSize="62%">
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
