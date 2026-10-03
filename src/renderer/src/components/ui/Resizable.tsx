import { useState, type ReactNode } from 'react'
import { Group, Panel as RPanel, Separator, type PanelProps } from 'react-resizable-panels'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../store/ui'

/** Resizable group whose layout is remembered in the UI store (persisted to localStorage). */
export function PanelGroup({
  id,
  orientation = 'horizontal',
  children,
  className,
}: {
  /** Unique per group: it is the persistence key. */
  id: string
  orientation?: 'horizontal' | 'vertical'
  children: ReactNode
  className?: string
}) {
  const [initial] = useState(() => useUiStore.getState().panelLayouts[id])
  const setLayout = useUiStore((s) => s.setPanelLayout)
  return (
    <Group
      id={id}
      orientation={orientation}
      defaultLayout={initial}
      onLayoutChanged={(layout) => setLayout(id, layout)}
      className={className}
    >
      {children}
    </Group>
  )
}

/** Sizes: numbers are pixels, strings are percentages unless they carry a unit (e.g. "220px"). */
export function ResizablePanel(props: PanelProps) {
  return <RPanel {...props} />
}

export function ResizeHandle({ orientation = 'horizontal' }: { orientation?: 'horizontal' | 'vertical' }) {
  return <Separator className={cn('shrink-0', orientation === 'horizontal' ? 'w-px' : 'h-px')} />
}
