import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NexusBridge } from '@shared/ipc'
import { api, hasBridge, IpcError, BRIDGE_UNAVAILABLE } from '../../../src/renderer/src/lib/bridge'

const g = globalThis as { nexus?: Partial<NexusBridge> }

afterEach(() => {
  delete g.nexus
})

describe('bridge', () => {
  it('fails with a clear typed error when window.nexus is missing', async () => {
    expect(hasBridge()).toBe(false)
    const err = await api.invoke('app.info', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IpcError)
    expect((err as IpcError).code).toBe(BRIDGE_UNAVAILABLE)
    expect((err as IpcError).message).toMatch(/window\.nexus/)
  })

  it('unwraps ok results', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: [{ id: 'p1' }] })
    g.nexus = { invoke, onPush: () => () => undefined }
    await expect(api.invoke('projects.list', {})).resolves.toEqual([{ id: 'p1' }])
    expect(invoke).toHaveBeenCalledWith('projects.list', {})
  })

  it('throws IpcError carrying code and channel for failures', async () => {
    g.nexus = {
      invoke: async () => ({ ok: false, error: { code: 'not_found', message: 'no such run' } }),
      onPush: () => () => undefined,
    }
    const err = await api.invoke('runs.get', { runId: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IpcError)
    expect(err).toMatchObject({ code: 'not_found', channel: 'runs.get', message: 'no such run' })
  })

  it('wraps a rejected invoke (transport failure)', async () => {
    g.nexus = {
      invoke: async () => {
        throw new Error('channel closed')
      },
      onPush: () => () => undefined,
    }
    await expect(api.invoke('app.info', {})).rejects.toMatchObject({ code: 'ipc_failure', message: 'channel closed' })
  })

  it('onPush is a no-op without a bridge and delegates with one', () => {
    expect(api.onPush(() => undefined)()).toBeUndefined()
    const unsub = vi.fn()
    const onPush = vi.fn().mockReturnValue(unsub)
    g.nexus = { invoke: vi.fn(), onPush }
    api.onPush(() => undefined)()
    expect(onPush).toHaveBeenCalledOnce()
    expect(unsub).toHaveBeenCalledOnce()
  })
})
