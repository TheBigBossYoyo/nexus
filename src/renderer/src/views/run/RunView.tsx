import { useCallback, useEffect, useState } from 'react'
import { ErrorNote, IconButton, ChevronDownIcon, ChevronUpIcon, Loading, PageHeader, Popover, SegmentedControl, Tabs, XIcon, type TabItem } from '../../components/ui'
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
import { ProgressPanel } from './ProgressPanel'
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

const BOTTOM_LABELS: Record<BottomTab, string> = {
  agents: 'Agents',
  timeline: 'Timeline',
  communications: 'Messages',
  tools: 'Tools',
  diff: 'Diff',
  reviews: 'Reviews',
  verification: 'Verification',
  decisions: 'Decisions',
  criteria: 'Criteria',
  usage: 'Usage',
}
const PRIMARY_BOTTOM: readonly BottomTab[] = ['agents', 'timeline', 'diff', 'reviews', 'usage']
const MORE_BOTTOM: readonly BottomTab[] = ['communications', 'tools', 'verification', 'decisions', 'criteria']
const BOTTOM_ITEMS: readonly TabItem<BottomTab>[] = PRIMARY_BOTTOM.map((id) => ({ id, label: BOTTOM_LABELS[id], testId: `bottom-tab-${id}` }))

/** True while the window is narrower than the breakpoint. */
function useNarrow(px: number): boolean {
  const query = `(max-width: ${px - 1}px)`
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setNarrow(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return narrow
}

function MoreTabs({ tab, onTab }: { tab: BottomTab; onTab: (t: BottomTab) => void }) {
  const [open, setOpen] = useState(false)
  const active = MORE_BOTTOM.includes(tab)
  return (
    <Popover
      label="More activity views"
      align="start"
      width={200}
      open={open}
      onOpenChange={setOpen}
      content={
        <div role="menu" className="flex flex-col p-1">
          {MORE_BOTTOM.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid={`bottom-tab-${id}`}
              className="rounded-sm px-2 py-1.5 text-left hover:bg-surface-hover"
              onClick={() => {
                onTab(id)
                setOpen(false)
              }}
            >
              {BOTTOM_LABELS[id]}
            </button>
          ))}
        </div>
      }
    >
      {(p) => (
        <button
          type="button"
          {...p}
          data-testid="bottom-tab-more"
          className={`-mb-px inline-flex h-[var(--row-h)] shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-2.5 font-medium ${active ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          {active ? BOTTOM_LABELS[tab] : 'More'}
          <ChevronDownIcon size={12} />
        </button>
      )}
    </Popover>
  )
}

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
        <div className="flex min-w-0 flex-1 items-end border-b">
          <Tabs tabs={BOTTOM_ITEMS} active={tab} onChange={onTab} label="Mission activity" bare className="min-w-0 px-3" />
          <MoreTabs tab={tab} onTab={onTab} />
        </div>
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

  // While a plan waits for approval the plan fills the stage: the activity panel folds away, then returns.
  useEffect(() => {
    const p = bottomRef.current
    if (!p) return
    if (state === 'awaiting_approval') p.collapse()
    else if (p.isCollapsed()) p.expand()
  }, [state, bottomRef])

  const narrow = useNarrow(1200)
  const taskId = useUiStore((st) => st.taskId)
  const selectTask = useUiStore((st) => st.selectTask)
  useEffect(() => {
    if (!narrow || !taskId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selectTask(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [narrow, taskId, selectTask])

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

  const center = (
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
          <BottomPanel tab={bottom} onTab={(t) => showBottom(t)} events={stream} collapsed={collapsed} onToggle={toggleBottom} />
        </ErrorBoundary>
      </ResizablePanel>
    </PanelGroup>
  )

  return (
    <RunProvider detail={query.data} events={stream.events} showStage={showStage} showBottom={showBottom}>
      <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
        <MissionHeader />
        <OvernightBanner runId={runId} />
        <ProgressPanel runId={runId} />
        <div className="relative min-h-0 flex-1">
          {narrow ? (
            <>
              {center}
              {taskId ? (
                <aside
                  aria-label="Task inspector"
                  data-testid="inspector-drawer"
                  className="anim-slide absolute inset-y-0 right-0 z-20 flex w-[min(480px,96%)] flex-col border-l bg-surface shadow-elevated"
                >
                  <div className="flex h-8 shrink-0 items-center justify-between border-b px-3 text-small text-text-muted">
                    <span>Task details</span>
                    <IconButton label="Close task details" size="sm" onClick={() => selectTask(null)} data-testid="inspector-close">
                      <XIcon size={12} />
                    </IconButton>
                  </div>
                  <div className="min-h-0 flex-1">
                    <ErrorBoundary label="Inspector failed">
                      <Inspector />
                    </ErrorBoundary>
                  </div>
                </aside>
              ) : null}
            </>
          ) : (
            <PanelGroup id="run-main">
              <ResizablePanel id="run-center" minSize="420px">
                {center}
              </ResizablePanel>
              <ResizeHandle />
              <ResizablePanel id="run-inspector" defaultSize="500px" minSize="480px" maxSize="60%">
                <ErrorBoundary label="Inspector failed">
                  <Inspector />
                </ErrorBoundary>
              </ResizablePanel>
            </PanelGroup>
          )}
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
