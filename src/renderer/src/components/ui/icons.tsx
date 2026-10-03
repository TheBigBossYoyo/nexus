import type { ReactNode, SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ size = 14, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </Svg>
)
export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 3l8 5-8 5z" />
  </Svg>
)
export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3v10M11 3v10" />
  </Svg>
)
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
  </Svg>
)
export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
)
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Svg>
)
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)
export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" />
  </Svg>
)
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 8.5h6.8l.6-8.5M6.7 7v4M9.3 7v4" />
  </Svg>
)
export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2l6.2 11H1.8zM8 6.5v3.2M8 11.6v.1" />
  </Svg>
)
export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.4V11M8 5v.1" />
  </Svg>
)
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Svg>
)
export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6L8 10.5 12.5 6" />
  </Svg>
)
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2L13.5 13.5" />
  </Svg>
)
export const BranchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.4" />
    <circle cx="4.5" cy="12.5" r="1.4" />
    <circle cx="11.5" cy="5.5" r="1.4" />
    <path d="M4.5 5v6M11.5 7c0 2.5-3.5 2-7 4" />
  </Svg>
)
export const RunsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.5 5.5l4 2.5-4 2.5z" />
  </Svg>
)
export const AgentsIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" />
    <path d="M6.5 1.8v1.7M9.5 1.8v1.7M6.5 12.5v1.7M9.5 12.5v1.7M1.8 6.5h1.7M1.8 9.5h1.7M12.5 6.5h1.7M12.5 9.5h1.7" />
    <rect x="6.3" y="6.3" width="3.4" height="3.4" />
  </Svg>
)
export const MemoryIcon = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8" />
  </Svg>
)
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </Svg>
)
export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="10.5" r="2.7" />
    <path d="M7 8.6L13.5 2.5M11 4.8l1.7 1.7" />
  </Svg>
)
export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8l5 1.8v4c0 3-2.2 5.2-5 6.6-2.8-1.4-5-3.6-5-6.6v-4z" />
  </Svg>
)
export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9v3.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7" />
  </Svg>
)
export const CommandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 5.5V4a1.5 1.5 0 1 0-1.5 1.5h8A1.5 1.5 0 1 0 10.5 4v8a1.5 1.5 0 1 0 1.5-1.5H4A1.5 1.5 0 1 0 5.5 12zM5.5 5.5h5v5h-5z" />
  </Svg>
)
export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 1.8h5.2l3.8 3.8v8.6h-9zM8.5 1.8v4h4" />
  </Svg>
)
