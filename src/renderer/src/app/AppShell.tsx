import { useMemo } from 'react'
import { ShellSlotsContext } from '../components/ui/PageHeader'
import { useApplySavedAppearance } from './appearance'
import { ApprovalBar, useAutoOpenApprovals } from '../views/approvals/ApprovalBar'
import { ApprovalDrawer } from '../views/approvals/ApprovalDrawer'
import { BoundaryInbox } from '../views/autonomy/BoundaryInbox'
import { RecoveryDialog } from '../views/recovery/RecoveryDialog'
import { AuthBanner } from './AuthBanner'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { GlobalStatus } from './GlobalStatus'
import { useHotkeys } from './hotkeys'
import { QuotaBanner } from './QuotaBanner'
import { Sidebar } from './Sidebar'
import { Toasts } from './Toasts'
import { ViewRouter } from './ViewRouter'
import { useConnectionStale } from '../store/connection'
import { ConnectionAnnouncer, ConnectionBanner, ConnectionContent, StartupState } from './ConnectionGate'

function Banners() {
  return (
    <>
      <QuotaBanner />
      <ApprovalBar />
      <AuthBanner />
    </>
  )
}

/** Left navigation + content column. Every page renders a PageHeader, which takes the status cluster and banners from here. */
export function AppShell() {
  useHotkeys()
  useApplySavedAppearance()
  useAutoOpenApprovals()
  const stale = useConnectionStale()
  const slots = useMemo(
    () => ({
      // While the connection to the runtime is lost nothing here may look live: no Claude, agent or run status
      // and no quota or approval banner, only a plain statement that the state is unknown.
      status: stale ? (
        <span className="text-small text-text-muted" data-testid="status-unknown" data-stale="true">
          Status unknown
        </span>
      ) : (
        <ErrorBoundary label="Status failed">
          <GlobalStatus />
        </ErrorBoundary>
      ),
      banners: stale ? null : (
        <ErrorBoundary label="Banners failed">
          <Banners />
        </ErrorBoundary>
      ),
    }),
    [stale],
  )
  return (
    <div className="flex h-full bg-background" data-testid="app-shell">
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-surface focus-visible:px-3 focus-visible:py-2 focus-visible:text-text-primary focus-visible:shadow-lg"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to main content
      </a>
      <ErrorBoundary label="Navigation failed">
        <Sidebar />
      </ErrorBoundary>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ErrorBoundary label="Connection banner failed">
          <ConnectionBanner />
        </ErrorBoundary>
        <ConnectionContent>
          <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <ShellSlotsContext.Provider value={slots}>
              <ViewRouter />
            </ShellSlotsContext.Provider>
          </main>
        </ConnectionContent>
      </div>
      <ConnectionAnnouncer />
      <StartupState />
      <ApprovalDrawer />
      <BoundaryInbox />
      <RecoveryDialog />
      <CommandPalette />
      <Toasts />
    </div>
  )
}
