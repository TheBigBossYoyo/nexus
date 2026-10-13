import type { NetworkOutage } from '@shared/connectivity'

/**
 * Where outage records go. The runtime backs this with the database (docs/NETWORK_RESILIENCE.md has the table);
 * the module itself only needs these two calls. `save` is an upsert by id and is called every time an open
 * outage gains a fact. A store that throws must not break supervision: the supervisor logs and goes on.
 */
export interface OutageStore {
  save(outage: NetworkOutage): void | Promise<void>
  /** Newest first. */
  recent(limit: number): NetworkOutage[] | Promise<NetworkOutage[]>
}

export class InMemoryOutageStore implements OutageStore {
  private readonly byId = new Map<string, NetworkOutage>()

  constructor(private readonly keep = 200) {}

  save(outage: NetworkOutage): void {
    // A copy, so a later change to the supervisor's open record cannot rewrite what was stored.
    this.byId.set(outage.id, structuredClone(outage))
    while (this.byId.size > this.keep) {
      const oldest = this.byId.keys().next().value
      if (oldest === undefined) break
      this.byId.delete(oldest)
    }
  }

  recent(limit: number): NetworkOutage[] {
    return [...this.byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, limit)).map((o) => structuredClone(o))
  }
}
