import { initialSchema } from './001-initial'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Append-only. Migrations are TypeScript modules (not .sql files) so the Vite-bundled main process needs no disk reads. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial', sql: initialSchema }]
