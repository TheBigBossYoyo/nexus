import { useMemo } from 'react'
import { ShellSlotsContext } from '../components/ui/PageHeader'
import { useApplySavedAppearance } from './appearance'
import { ApprovalBar, useAutoOpenApprovals } from '../views/approvals/ApprovalBar'
import { ApprovalDrawer } from '../views/approvals/ApprovalDrawer'
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
  const slots = useMemo(
    () => ({
      status: (
        <ErrorBoundary label="Status failed">
          <GlobalStatus />
        </ErrorBoundary>
      ),
      banners: (
        <ErrorBoundary label="Banners failed">
          <Banners />
        </ErrorBoundary>
      ),
    }),
    [],
  )
  return (
    <div className="flex h-full bg-background" data-testid="app-shell">
      <ErrorBoundary label="Navigation failed">
        <Sidebar />
      </ErrorBoundary>
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <ShellSlotsContext.Provider value={slots}>
          <ViewRouter />
        </ShellSlotsContext.Provider>
      </main>
      <ApprovalDrawer />
      <RecoveryDialog />
      <CommandPalette />
      <Toasts />
    </div>
  )
}
