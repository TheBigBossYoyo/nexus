import type { View } from '../store/views'

export type NavGroupId = 'workspace' | 'intelligence' | 'system'

export interface NavItem {
  view: View
  label: string
  group: NavGroupId
  /** Words the command palette also matches. */
  keywords: string
}

/** Navigation order. Ctrl+1..9 map to the first nine entries in this order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { view: 'home', label: 'Home', group: 'workspace', keywords: 'overview dashboard start' },
  {
    view: 'projects',
    label: 'Projects',
    group: 'workspace',
    keywords: 'repository repo open mission composer',
  },
  { view: 'run', label: 'Missions', group: 'workspace', keywords: 'runs run plan graph tasks' },
  {
    view: 'programs',
    label: 'Programs',
    group: 'workspace',
    keywords: 'program milestones roadmap goal long horizon backlog background engineering',
  },
  {
    view: 'workspaces',
    label: 'Workspaces',
    group: 'workspace',
    keywords: 'workspace repositories multi repo contracts dependency graph release train cross-repository',
  },
  { view: 'agents', label: 'Agents', group: 'workspace', keywords: 'workers output tools' },
  {
    view: 'arena',
    label: 'Arena',
    group: 'intelligence',
    keywords: 'strategies campaigns compare benchmark',
  },
  {
    view: 'policy',
    label: 'Policy',
    group: 'intelligence',
    keywords: 'adaptive strategy preferences',
  },
  {
    view: 'usage',
    label: 'Usage',
    group: 'intelligence',
    keywords: 'claude tokens limit quota subscription',
  },
  {
    view: 'providers',
    label: 'Providers',
    group: 'intelligence',
    keywords: 'provider claude codex gemini model cross-model review heterogeneous routing fallback',
  },
  {
    view: 'performance',
    label: 'Performance',
    group: 'intelligence',
    keywords: 'metrics outcomes success',
  },
  {
    view: 'intelligence',
    label: 'Repository',
    group: 'intelligence',
    keywords: 'repository intelligence facts files',
  },
  {
    view: 'control',
    label: 'Control Center',
    group: 'system',
    keywords: 'control plane queue scheduler priority capacity schedules runtime health incidents',
  },
  {
    view: 'overnight',
    label: 'Overnight',
    group: 'system',
    keywords: 'night unattended shutdown deadline',
  },
  { view: 'activity', label: 'Activity', group: 'system', keywords: 'events feed log history' },
  { view: 'memory', label: 'Memory', group: 'system', keywords: 'notes knowledge decisions' },
  {
    view: 'settings',
    label: 'Settings',
    group: 'system',
    keywords: 'preferences configuration appearance',
  },
]

export const NAV_GROUPS: readonly { id: NavGroupId; label: string }[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'system', label: 'System' },
]

export const NUMBERED_VIEWS: readonly View[] = NAV_ITEMS.slice(0, 9).map((n) => n.view)

/** Page title and breadcrumb context per view. */
export const VIEW_META: Record<View, { title: string; context?: string }> = {
  home: { title: 'Home' },
  projects: { title: 'Projects', context: 'Workspace' },
  run: { title: 'Missions', context: 'Workspace' },
  programs: { title: 'Programs', context: 'Workspace' },
  workspaces: { title: 'Workspaces', context: 'Workspace' },
  agents: { title: 'Agents', context: 'Workspace' },
  arena: { title: 'Arena', context: 'Intelligence' },
  policy: { title: 'Policy', context: 'Intelligence' },
  providers: { title: 'Providers', context: 'Intelligence' },
  usage: { title: 'Usage', context: 'Intelligence' },
  performance: { title: 'Performance', context: 'Intelligence' },
  intelligence: { title: 'Repository', context: 'Intelligence' },
  control: { title: 'Control Center', context: 'System' },
  overnight: { title: 'Overnight', context: 'System' },
  activity: { title: 'Activity', context: 'System' },
  memory: { title: 'Memory', context: 'System' },
  settings: { title: 'Settings', context: 'System' },
  auth: { title: 'Authentication', context: 'System' },
}

/** Views that render their own PageHeader. The shell adds a default one for every other view. */
export const VIEWS_WITH_OWN_HEADER: readonly View[] = [
  'home',
  'projects',
  'programs',
  'workspaces',
  'arena',
  'policy',
  'providers',
  'usage',
  'control',
  'overnight',
  'activity',
  'settings',
  'agents',
  'memory',
  'performance',
  'intelligence',
  'auth',
  'run',
]
