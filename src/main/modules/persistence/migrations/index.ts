import { initialSchema } from './001-initial'
import { v02Schema } from './002-v0-2'
import { overnightSchema } from './003-overnight'
import { v03Schema } from './004-v0-3'
import { workloadSchema } from './005-overnight-workloads'
import { programsSchema } from './006-programs'
import { workspacesSchema } from './007-workspaces'
import { providersSchema } from './008-providers'
import { controlPlaneSchema } from './009-control-plane'
import { workersSchema } from './010-workers'
import { securitySchema } from './011-security'
import { contextGraphSchema } from './012-context-graph'
import { intelligenceSchema } from './013-intelligence'
import { canonicalIntentsSchema } from './014-canonical-intents'
import { capacityDirectorSchema } from './015-capacity-director'
import { adviceOutcomesSchema } from './016-advice-outcomes'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Append-only. Migrations are TypeScript modules (not .sql files) so the Vite-bundled main process needs no disk reads. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initialSchema },
  { version: 2, name: 'v0-2', sql: v02Schema },
  { version: 3, name: 'overnight', sql: overnightSchema },
  { version: 4, name: 'v0-3', sql: v03Schema },
  { version: 5, name: 'overnight-workloads', sql: workloadSchema },
  { version: 6, name: 'programs', sql: programsSchema },
  { version: 7, name: 'workspaces', sql: workspacesSchema },
  { version: 8, name: 'providers', sql: providersSchema },
  { version: 9, name: 'control-plane', sql: controlPlaneSchema },
  { version: 10, name: 'workers', sql: workersSchema },
  { version: 11, name: 'security', sql: securitySchema },
  { version: 12, name: 'context-graph', sql: contextGraphSchema },
  { version: 13, name: 'intelligence', sql: intelligenceSchema },
  { version: 14, name: 'canonical-intents', sql: canonicalIntentsSchema },
  { version: 15, name: 'capacity-director', sql: capacityDirectorSchema },
  { version: 16, name: 'advice-outcomes', sql: adviceOutcomesSchema },
]
