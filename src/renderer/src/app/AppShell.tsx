import { PanelGroup, ResizablePanel, ResizeHandle } from '../components/ui/Resizable'
import { useApplySavedAppearance } from './appearance'
import { ApprovalBar, ApprovalDrawer } from './Approvals'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { useHotkeys } from './hotkeys'
import { Sidebar } from './Sidebar'
import { Toasts } from './Toasts'
import { TopBar } from './TopBar'
import { ViewRouter } from './ViewRouter'

export function AppShell() {
  useHotkeys()
  useApplySavedAppearance()
  return (
    <div className="flex h-full flex-col" data-testid="app-shell">
      <ErrorBoundary label="Top bar failed">
        <TopBar />
      </ErrorBoundary>
      <ApprovalBar />
      <div className="min-h-0 flex-1">
        <PanelGroup id="shell">
          <ResizablePanel id="sidebar" defaultSize="230px" minSize="180px" maxSize="380px">
            <ErrorBoundary label="Sidebar failed">
              <Sidebar />
            </ErrorBoundary>
          </ResizablePanel>
          <ResizeHandle />
          <ResizablePanel id="main" minSize="480px">
            <main className="h-full min-h-0 overflow-hidden bg-surface-0">
              <ViewRouter />
            </main>
          </ResizablePanel>
        </PanelGroup>
      </div>
      <ApprovalDrawer />
      <CommandPalette />
      <Toasts />
    </div>
  )
}
