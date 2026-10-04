import { initialSchema } from './001-initial'
import { v02Schema } from './002-v0-2'
import { overnightSchema } from './003-overnight'

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
]
