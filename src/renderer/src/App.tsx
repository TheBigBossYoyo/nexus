import { useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { AppShell } from './app/AppShell'
import { ErrorBoundary } from './app/ErrorBoundary'
import { createQueryClient } from './lib/queryClient'
import { startPush } from './lib/push'

export function App() {
  const [queryClient] = useState(createQueryClient)

  // One push subscription for the lifetime of the app.
  useEffect(() => startPush(queryClient), [queryClient])

  return (
    <ErrorBoundary label="NEXUS failed to render">
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
