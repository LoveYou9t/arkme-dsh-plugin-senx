import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ArkmeSecureValueStore } from '../src/keychain-store.js'
import { DesktopCredentialBroker } from '../src/dsh-remote/desktop-credential-broker.js'
import { DshRemoteRuntimeStore } from '../src/dsh-remote/runtime-store.js'

class MemorySecrets implements ArkmeSecureValueStore {
  readonly values = new Map<string, string>()
  async read(account: string) { return this.values.get(account) }
  async write(account: string, payload: string) { this.values.set(account, payload) }
  async delete(account: string) { this.values.delete(account) }
}

describe('Desktop Credential Broker', () => {
  it('shares one installation identity across Profiles while isolating accounts', async () => {
    const secrets = new MemorySecrets()
    const firstProfile = new DesktopCredentialBroker(secrets)
    const secondProfile = new DesktopCredentialBroker(secrets)
    const accountOneFirst = await firstProfile.getOrCreate('account-1')
    const accountOneSecond = await secondProfile.getOrCreate('account-1')
    const accountTwo = await firstProfile.getOrCreate('account-2')
    expect(accountOneSecond.publicKey).toBe(accountOneFirst.publicKey)
    expect(accountTwo.publicKey).not.toBe(accountOneFirst.publicKey)
    expect(await firstProfile.ledgerKey('account-1')).toHaveLength(32)
    expect([...secrets.values.values()].join('')).not.toContain('accessToken')
  })

  it('rotates only the requested account and advances key epoch', async () => {
    const broker = new DesktopCredentialBroker(new MemorySecrets())
    const before = await broker.getOrCreate('account-1')
    const rotated = await broker.rotate('account-1')
    expect(rotated.keyEpoch).toBe(2)
    expect(rotated.publicKey).not.toBe(before.publicKey)
  })

  it('shares immutable Binding trust across Profiles while isolating Runtime channel state', async () => {
    const secrets = new MemorySecrets()
    const broker = new DesktopCredentialBroker(secrets)
    const rootSecret = Buffer.alloc(32, 8)
    const controllerPublicKey = 'A'.repeat(43)
    const controllerKeyFingerprint = 'F'.repeat(43)
    await broker.putBindingRoot({
      accountId: 'account-1', bindingRef: 'binding-1', rootSecret,
      controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 1), hostToController: Buffer.alloc(32, 2),
    })
    await broker.putChannelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-1', channelRef: 'remotech-one',
      keyEpoch: 2, rootSecret, controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 1), hostToController: Buffer.alloc(32, 2),
      lastTransportSequence: 257,
    })
    await broker.putChannelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-2', channelRef: 'remotech-two',
      keyEpoch: 3, rootSecret, controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 3), hostToController: Buffer.alloc(32, 4),
    })
    expect((await broker.channelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-1', channelRef: 'remotech-one',
    }))).toMatchObject({ controllerToHost: Buffer.alloc(32, 1), lastTransportSequence: 257 })
    expect((await broker.channelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-2', channelRef: 'remotech-two',
    }))).toMatchObject({ controllerToHost: Buffer.alloc(32, 3), lastTransportSequence: 0 })
    expect(await broker.channelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-1', channelRef: 'remotech-two',
    })).toMatchObject({ keyEpoch: 1, rootSecret, lastTransportSequence: 0 })
    await expect(broker.putBindingRoot({
      accountId: 'account-1', bindingRef: 'binding-1', rootSecret: Buffer.alloc(32, 9),
      controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 1), hostToController: Buffer.alloc(32, 2),
    })).rejects.toMatchObject({ code: 'DEVICE_PROOF_INVALID' })
    await broker.deleteBindingChannelKeys({ accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-1' })
    expect(await broker.channelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-1', channelRef: 'remotech-one',
    })).toBeUndefined()
    expect(await broker.channelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-2', channelRef: 'remotech-two',
    })).toBeUndefined()
    await expect(broker.putChannelKeys({
      accountId: 'account-1', bindingRef: 'binding-1', runtimeRef: 'runtime-2', channelRef: 'remotech-two',
      keyEpoch: 4, rootSecret, controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 5), hostToController: Buffer.alloc(32, 6),
    })).rejects.toMatchObject({ code: 'BINDING_REVOKED' })
    await expect(new DesktopCredentialBroker(secrets).putBindingRoot({
      accountId: 'account-1', bindingRef: 'binding-1', rootSecret,
      controllerPublicKey, controllerKeyFingerprint,
      controllerToHost: Buffer.alloc(32, 1), hostToController: Buffer.alloc(32, 2),
    })).rejects.toMatchObject({ code: 'BINDING_REVOKED' })
  })
})

describe('DSH remote Runtime store', () => {
  it('defaults every new Profile to disabled and increments generation on activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote runtime '))
    const store = new DshRemoteRuntimeStore(directory)
    const first = await store.activateRuntime({ accountId: 'account-1', profileRef: 'profile-a', capabilities: ['workspace.list'] })
    expect(first.remoteEnabled).toBe(false)
    expect(first.hostGeneration).toBe(1)
    await store.setRemoteEnabled('account-1', 'profile-a', true)
    const restarted = await new DshRemoteRuntimeStore(directory).activateRuntime({
      accountId: 'account-1', profileRef: 'profile-a', capabilities: ['workspace.list', 'session.list'],
    })
    expect(restarted.runtimeRef).toBe(first.runtimeRef)
    expect(restarted.remoteEnabled).toBe(true)
    expect(restarted.hostGeneration).toBe(2)
    const adopted = await store.adoptRuntimeRef('account-1', 'profile-a', 'runtime-backend-01', 7)
    expect(adopted.hostGeneration).toBe(7)
    await expect(store.adoptRuntimeRef('account-1', 'profile-a', 'runtime-backend-01', 6))
      .rejects.toMatchObject({ code: 'REMOTE_STORAGE_FAILED' })
  })

  it('keeps account namespaces independent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme-remote-runtime-'))
    const store = new DshRemoteRuntimeStore(directory)
    await store.activateRuntime({ accountId: 'account-1', profileRef: 'web', capabilities: [] })
    await store.activateRuntime({ accountId: 'account-2', profileRef: 'web', capabilities: [] })
    await store.setRemoteEnabled('account-1', 'web', true)
    expect((await store.account('account-1')).runtimes[0]?.remoteEnabled).toBe(true)
    expect((await store.account('account-2')).runtimes[0]?.remoteEnabled).toBe(false)
  })
})
