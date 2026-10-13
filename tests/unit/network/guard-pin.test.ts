import { describe, expect, it } from 'vitest'
import { nat64Embedded } from '@main/modules/network/address'
import { pin } from '@main/modules/network/guard'
import { policyForPurpose } from '@main/modules/network/policy'

const policy = policyForPurpose('PUBLIC_RESEARCH', {})
const pinned = (addresses: string[]) => pin({ policy, resolver: async () => addresses }, 'test', 'GET', 'example.org', 443)

describe('an answer of a DNS64 resolver', () => {
  it('the address made up from an IPv4 address of the same answer is left out, and the IPv4 address is used', async () => {
    expect(nat64Embedded('64:ff9b::8c52:7903')).toBe('140.82.121.3')
    expect(nat64Embedded('64:ff9b:1::8c52:7903')).toBeNull()
    expect(nat64Embedded('2606:4700::6810:1')).toBeNull()
    expect(nat64Embedded('140.82.121.3')).toBeNull()
    expect((await pinned(['64:ff9b::8c52:7903', '140.82.121.3'])).address).toBe('140.82.121.3')
    expect((await pinned(['140.82.121.3', '64:ff9b::8c52:7903'])).address).toBe('140.82.121.3')
    expect((await pinned(['64:ff9b::8c52:7903', '64:ff9b::8c52:7904', '140.82.121.4', '140.82.121.3'])).address).toBe('140.82.121.4')
  })

  it('any other translated address is refused as before', async () => {
    // Alone: nothing in the answer says where it leads but itself.
    await expect(pinned(['64:ff9b::8c52:7903'])).rejects.toThrow(/not public/)
    // Made up from another address than the one beside it.
    await expect(pinned(['64:ff9b::8c52:7999', '140.82.121.3'])).rejects.toThrow(/not public/)
    // Leading to this machine or a private network, with a public address beside it.
    await expect(pinned(['64:ff9b::7f00:1', '140.82.121.3'])).rejects.toThrow(/not public/)
    await expect(pinned(['64:ff9b::a00:1', '140.82.121.3'])).rejects.toThrow(/not public/)
    // The same private address in both forms: left out, and the IPv4 one is refused on its own.
    await expect(pinned(['64:ff9b::a00:1', '10.0.0.1'])).rejects.toThrow(/not public/)
    await expect(pinned(['::ffff:140.82.121.3', '140.82.121.3'])).rejects.toThrow(/not public/)
    await expect(pinned(['140.82.121.3', '::1'])).rejects.toThrow(/not public/)
  })
})
