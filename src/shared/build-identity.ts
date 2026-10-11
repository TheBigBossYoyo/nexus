export interface BuildIdentity {
  version: string
  commit: string
  dirty: boolean
  builtAt: string | null
  channel: 'development' | 'candidate'
  runtimeProtocol: number
  databaseSchema: number
}

declare const __NEXUS_BUILD__: Omit<BuildIdentity, 'runtimeProtocol' | 'databaseSchema'>

/** Embedded by the bundler. Tests and unbundled hosts explicitly report an unknown build. */
export const BUILD_STAMP: Omit<BuildIdentity, 'runtimeProtocol' | 'databaseSchema'> =
  typeof __NEXUS_BUILD__ === 'undefined'
    ? {
        version: 'unbundled',
        commit: 'unknown',
        dirty: false,
        builtAt: null,
        channel: 'development',
      }
    : __NEXUS_BUILD__
