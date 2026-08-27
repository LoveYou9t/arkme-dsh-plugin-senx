import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArkmeSecureValueStore } from '../src/keychain-store.js'
import { DshApiProxyAdapter } from '../src/dsh-remote/api-proxy-adapter.js'
import { DshRemoteCommandLedger } from '../src/dsh-remote/command-ledger.js'
import { DesktopCredentialBroker } from '../src/dsh-remote/desktop-credential-broker.js'
import { generateEd25519DeviceKey, verifyEd25519 } from '../src/dsh-remote/crypto.js'
import { DshRemoteError } from '../src/dsh-remote/errors.js'
import { ArkmeRemoteRealtimeHost } from '../src/dsh-remote/host.js'
import { DshRemoteRuntimeStore } from '../src/dsh-remote/runtime-store.js'
import type { DshRemoteBindingProjection, DshRemoteControlPlane, DshRemoteRealtimeTransport } from '../src/dsh-remote/types.js'

class MemorySecrets implements ArkmeSecureValueStore {
  private readonly values = new Map<string, string>()
  async read(account: string) { return this.values.get(account) }
  async write(account: string, value: string) { this.values.set(account, value) }
  async delete(account: string) { this.values.delete(account) }
}

afterEach(() => { vi.useRealTimers() })

describe('Host durable registration lifecycle', () => {
  it('does not subscribe to DSH events while the global feature or local Runtime switch is off', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote disabled '))
    const mux = vi.fn(async function* () { yield* [] })
    const base = {
      environment: 'test' as const, profileRef: 'web', hostClientRef: 'host-client-test',
      readSession: async () => ({ userId: 42, clientId: 9 }),
      credentialBroker: new DesktopCredentialBroker(new MemorySecrets()), runtimeStore: new DshRemoteRuntimeStore(directory),
      controlPlane: {} as DshRemoteControlPlane,
      realtime: { subscribeDisconnect: () => () => undefined, disconnect: async () => undefined } as unknown as DshRemoteRealtimeTransport,
      grantSigningKeys: { test: 'A'.repeat(43) },
      ledgerForAccount: () => new DshRemoteCommandLedger(join(directory, 'ledger'), Buffer.alloc(32, 9)),
      apiProxy: new DshApiProxyAdapter({ events: { mux } }),
    }
    const disabled = new ArkmeRemoteRealtimeHost({ ...base, featureEnabled: false })
    await disabled.start()
    expect(mux).not.toHaveBeenCalled()
    await disabled.stop()

    const localOff = new ArkmeRemoteRealtimeHost({ ...base, featureEnabled: true })
    await localOff.start()
    expect(localOff.getStatus().enabled).toBe(false)
    expect(mux).not.toHaveBeenCalled()
    await localOff.stop()
  })

  it('purges persisted pairwise keys when a binding projection becomes revoked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote revoked binding '))
    const broker = new DesktopCredentialBroker(new MemorySecrets())
    const active: DshRemoteBindingProjection = {
      bindingRef: 'binding-revoked-test-01', controllerCredentialRef: 'controller-revoked-test-01',
      controllerDisplayName: 'Phone', controllerPlatform: 'ios', revision: 1, status: 'active',
      scopes: ['session.read'], boundAtMillis: 1,
    }
    await broker.putChannelKeys({
      accountId: '42', bindingRef: active.bindingRef, runtimeRef: 'runtime-revoked-test-01',
      channelRef: 'remotech-revoked-test-01', keyEpoch: 2, rootSecret: Buffer.alloc(32, 1),
      controllerPublicKey: 'A'.repeat(43), controllerKeyFingerprint: 'B'.repeat(43),
      controllerToHost: Buffer.alloc(32, 2), hostToController: Buffer.alloc(32, 3),
    })
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, environment: 'test', profileRef: 'web', hostClientRef: 'host-client-test',
      readSession: async () => ({ userId: 42, clientId: 9 }), credentialBroker: broker,
      runtimeStore: new DshRemoteRuntimeStore(directory),
      controlPlane: { listBindings: async () => [{ ...active, status: 'revoked' }] } as unknown as DshRemoteControlPlane,
      realtime: { disconnect: async () => undefined } as unknown as DshRemoteRealtimeTransport,
      apiProxy: new DshApiProxyAdapter({}), grantSigningKeys: {}, ledgerForAccount: () => { throw new Error('unused') },
    })
    Object.assign(host, {
      started: true, accountId: '42', userId: 42, clientId: 9, identity: generateEd25519DeviceKey('42'),
      runtime: {
        runtimeRef: 'runtime-revoked-test-01', profileRef: 'web', accountId: '42', remoteEnabled: true,
        hostGeneration: 1, capabilities: [], updatedAtMillis: 1,
      },
      bindings: [active],
    })
    await host.listBindings()
    expect(await broker.channelKeys({
      accountId: '42', bindingRef: active.bindingRef, runtimeRef: 'runtime-revoked-test-01',
      channelRef: 'remotech-revoked-test-01',
    })).toBeUndefined()
    await host.stop()
  })

  it('uses the exact Backend device -> desktop -> runtime -> policy wire before Realtime registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote registration '))
    const calls: Array<{ name: string; value: Record<string, unknown> }> = []
    const controlPlane = {
      registerDeviceCredential: async (value: Record<string, unknown>) => {
        calls.push({ name: 'credential', value })
        return { credential_ref: 'credential-host-test-01' }
      },
      registerDesktop: async (value: Record<string, unknown>) => {
        calls.push({ name: 'desktop', value })
        return { desktop_ref: 'desktop-host-test-01', credential_ref: 'credential-host-test-01' }
      },
      registerRuntime: async (_desktopRef: string, value: Record<string, unknown>) => {
        calls.push({ name: 'runtime', value })
        return { runtime_ref: 'runtime-host-test-01', runtime_revision: 1 }
      },
      updateRuntimePolicy: async (_desktopRef: string, _runtimeRef: string, value: Record<string, unknown>) => {
        calls.push({ name: 'policy', value })
        return { runtime_revision: 2 }
      },
    } as unknown as DshRemoteControlPlane
    const realtime = {
      subscribeDisconnect: () => () => undefined,
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      registerHost: vi.fn(async () => ({ serviceLeaseGeneration: 9 })), unregisterHost: vi.fn(async () => undefined),
    } as unknown as DshRemoteRealtimeTransport
    const ledger = new DshRemoteCommandLedger(join(directory, 'ledger'), Buffer.alloc(32, 5))
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, transportAvailable: true, environment: 'test', profileRef: 'web',
      hostClientRef: 'host-client-test', displayName: 'My Mac', readSession: async () => ({ userId: 42, clientId: 9 }),
      credentialBroker: new DesktopCredentialBroker(new MemorySecrets()), runtimeStore: new DshRemoteRuntimeStore(directory),
      controlPlane, realtime, grantSigningKeys: { test: 'A'.repeat(43) }, ledgerForAccount: () => ledger,
      apiProxy: new DshApiProxyAdapter({ workspace: { list: async request => ({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      }) } }),
    })
    await host.start()
    expect(host.getStatus().enabled).toBe(false)
    await host.setEnabled(true)
    expect(calls.map(call => call.name)).toEqual(['credential', 'desktop', 'runtime', 'policy'])
    const credential = calls[0]!.value
    expect(Object.keys(credential).sort()).toEqual([
      'device_name', 'key_epoch', 'platform', 'proof_nonce', 'proof_signature', 'public_signing_key', 'role',
    ])
    expect(verifyEd25519(String(credential.public_signing_key), [
      'dsh-remote.device-credential.register.v1', '42', '9', 'desktop', '1',
      String(credential.public_signing_key), String(credential.proof_nonce),
    ].join('\n'), String(credential.proof_signature))).toBe(true)
    expect(Object.keys(calls[1]!.value).sort()).toEqual([
      'credential_ref', 'display_name', 'platform', 'proof_nonce', 'proof_signature',
    ])
    expect(calls[2]!.value).toMatchObject({
      profile_ref: 'web', host_client_ref: 'host-client-test', service_namespace: 'dsh_remote',
      service_name: 'host', protocol_major: 1, host_generation: 1,
    })
    expect(Object.keys(calls[2]!.value).sort()).toEqual([
      'capabilities', 'host_client_ref', 'host_generation', 'profile_ref', 'proof_nonce', 'proof_signature',
      'protocol_major', 'service_name', 'service_namespace',
    ])
    expect(Object.keys(calls[3]!.value).sort()).toEqual([
      'expected_revision', 'proof_nonce', 'proof_signature', 'remote_enabled',
    ])
    expect(calls[3]!.value).toMatchObject({ expected_revision: 1, remote_enabled: true })
    expect(realtime.registerHost).toHaveBeenCalledWith(expect.objectContaining({ runtimeRef: 'runtime-host-test-01' }))
    await host.stop()
  })

  it('activates after a later login and closes the Host channel when that account logs out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote auth lifecycle '))
    let session: { userId: number; clientId: number } | undefined
    const controlPlane = {
      registerDeviceCredential: vi.fn(async () => ({ credential_ref: 'credential-host-test-02' })),
      registerDesktop: vi.fn(async () => ({ desktop_ref: 'desktop-host-test-02', credential_ref: 'credential-host-test-02' })),
      registerRuntime: vi.fn(async () => ({ runtime_ref: 'runtime-host-test-02', runtime_revision: 1 })),
      updateRuntimePolicy: vi.fn(async () => ({ runtime_revision: 2 })),
      listBindings: vi.fn(async () => []),
    } as unknown as DshRemoteControlPlane
    const realtime = {
      subscribeDisconnect: () => () => undefined,
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      registerHost: vi.fn(async () => ({ serviceLeaseGeneration: 10 })), unregisterHost: vi.fn(async () => undefined),
    } as unknown as DshRemoteRealtimeTransport
    const ledger = new DshRemoteCommandLedger(join(directory, 'ledger'), Buffer.alloc(32, 6))
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, transportAvailable: true, environment: 'test', profileRef: 'web',
      hostClientRef: 'host-client-test', readSession: async () => session,
      credentialBroker: new DesktopCredentialBroker(new MemorySecrets()), runtimeStore: new DshRemoteRuntimeStore(directory),
      controlPlane, realtime, grantSigningKeys: { test: 'A'.repeat(43) }, ledgerForAccount: () => ledger,
      apiProxy: new DshApiProxyAdapter({ workspace: { list: async request => ({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      }) } }),
    })
    await host.start()
    expect(host.getStatus()).toMatchObject({ available: false, unavailableReason: '请先登录 Arkme 后再配置远控' })
    session = { userId: 42, clientId: 9 }
    await (host as unknown as { syncSession(): Promise<void> }).syncSession()
    expect(host.getStatus()).toMatchObject({ accountId: '42', enabled: false })
    await host.setEnabled(true)
    expect(host.getStatus()).toMatchObject({ enabled: true, connected: true })
    session = undefined
    await (host as unknown as { syncSession(): Promise<void> }).syncSession()
    expect(host.getStatus()).toMatchObject({ available: false, connected: false, unavailableReason: '请先登录 Arkme 后再配置远控' })
    expect(realtime.unregisterHost).toHaveBeenCalled()
    expect(realtime.disconnect).toHaveBeenCalled()
    await host.stop()
  })

  it('surfaces a Runtime capacity failure without automatically replaying registration', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote runtime limit '))
    const registerRuntime = vi.fn(async () => {
      throw new DshRemoteError('RUNTIME_LIMIT_REACHED', '该电脑已达 Runtime 上限')
    })
    const controlPlane = {
      registerDeviceCredential: vi.fn(async () => ({ credential_ref: 'credential-host-limit-01' })),
      registerDesktop: vi.fn(async () => ({
        desktop_ref: 'desktop-host-limit-01', credential_ref: 'credential-host-limit-01',
      })),
      registerRuntime,
    } as unknown as DshRemoteControlPlane
    const realtime = {
      subscribeDisconnect: () => () => undefined,
      disconnect: vi.fn(async () => undefined),
    } as unknown as DshRemoteRealtimeTransport
    const ledger = new DshRemoteCommandLedger(join(directory, 'ledger'), Buffer.alloc(32, 7))
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, transportAvailable: true, environment: 'test', profileRef: 'web',
      hostClientRef: 'host-client-test', readSession: async () => ({ userId: 42, clientId: 9 }),
      credentialBroker: new DesktopCredentialBroker(new MemorySecrets()), runtimeStore: new DshRemoteRuntimeStore(directory),
      controlPlane, realtime, grantSigningKeys: { test: 'A'.repeat(43) }, ledgerForAccount: () => ledger,
      apiProxy: new DshApiProxyAdapter({ workspace: { list: async request => ({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      }) } }),
    })
    await host.start()
    await expect(host.setEnabled(true)).rejects.toMatchObject({ code: 'RUNTIME_LIMIT_REACHED', retryable: false })
    expect(host.getStatus()).toMatchObject({ connected: false, unavailableReason: '该电脑已达 Runtime 上限' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(registerRuntime).toHaveBeenCalledTimes(1)
    await host.stop()
  })
})
