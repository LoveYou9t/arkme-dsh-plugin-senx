import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DshApiProxyAdapter, type DshPublicApiProxyLike } from '../src/dsh-remote/api-proxy-adapter.js'
import { DshRemoteCommandLedger } from '../src/dsh-remote/command-ledger.js'
import { DesktopCredentialBroker } from '../src/dsh-remote/desktop-credential-broker.js'
import { generateEd25519DeviceKey } from '../src/dsh-remote/crypto.js'
import { ArkmeRemoteRealtimeHost } from '../src/dsh-remote/host.js'
import { DshRemoteRuntimeStore } from '../src/dsh-remote/runtime-store.js'
import type { ArkmeSecureValueStore } from '../src/keychain-store.js'
import type {
  DshRemoteBindingProjection,
  DshRemoteControlPlane,
  DshRemoteRealtimeTransport,
  DshRemoteRuntimeProjection,
} from '../src/dsh-remote/types.js'

class MemorySecrets implements ArkmeSecureValueStore {
  private readonly values = new Map<string, string>()
  async read(account: string) { return this.values.get(account) }
  async write(account: string, value: string) { this.values.set(account, value) }
  async delete(account: string) { this.values.delete(account) }
}

function ok<T>(value: T, rpcId: string) { return { rpcId, result: { ok: true as const, value } } }

describe('Arkme remote Host canonical operation contract', () => {
  it('maps snake_case prompt bodies to ApiProxy and replays a known rejection without re-execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arkme remote host contract '))
    const workspace = join(directory, 'workspace')
    await mkdir(workspace)
    const prompt = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: false as const, error: { code: 'agent-busy', message: 'busy' } },
    }))
    const api: DshPublicApiProxyLike = {
      workspace: { list: async request => ok({
        items: [{ workspaceId: 'workspace-1', path: workspace, title: 'Project', sessionIds: ['session-1'] }],
      }, request.rpcId) },
      sessions: {
        list: async request => ok({ items: [{ sessionId: 'session-1', updatedAt: 1, running: true, blank: false }] }, request.rpcId),
        prompt,
      },
    }
    const ledger = new DshRemoteCommandLedger(join(directory, 'ledger'), Buffer.alloc(32, 7), { now: () => 1_500 })
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, environment: 'test', profileRef: 'web', hostClientRef: 'host-client-test',
      readSession: async () => ({ userId: 1, clientId: 2 }), credentialBroker: new DesktopCredentialBroker(new MemorySecrets()),
      runtimeStore: new DshRemoteRuntimeStore(directory), controlPlane: {} as DshRemoteControlPlane,
      realtime: {} as DshRemoteRealtimeTransport, apiProxy: new DshApiProxyAdapter(api),
      ledgerForAccount: () => ledger, grantSigningKeys: {}, now: () => 1_500,
    })
    const binding: DshRemoteBindingProjection = {
      bindingRef: 'binding-test-01', controllerCredentialRef: 'controller-test-01',
      controllerDisplayName: 'Phone', controllerPlatform: 'ios', revision: 1, status: 'active',
      scopes: ['session.prompt'], boundAtMillis: 1,
    }
    const runtime: DshRemoteRuntimeProjection = {
      runtimeRef: 'runtime-test-01', desktopRef: 'desktop-test-01', profileRef: 'web', accountId: '1',
      remoteEnabled: true, hostGeneration: 7, capabilities: ['session.prompt'], updatedAtMillis: 1,
    }
    Object.assign(host, {
      accountId: '1', identity: generateEd25519DeviceKey('1'), runtime, ledger,
      started: true, connected: true, serviceLeaseGeneration: 9,
      bindings: [binding],
    })
    const request = {
      protocol: 'dsh.remote', protocol_major: 1, kind: 'request', request_ref: 'request-test-01',
      host_generation: 7, issued_at: 1_000, execute_before: 2_000, operation: 'session.prompt',
      body: { session_ref: 'session-1', mode: 'queue', content: { type: 'text', text: 'hello' } },
    }
    const context = {
      bindingRef: binding.bindingRef, serviceLeaseGeneration: 9,
      metadata: {
        senderRole: 'controller' as const, senderCredentialRef: binding.controllerCredentialRef,
        authorizationRef: 'authorization-test-01', subjectRevision: 1, remoteAuthEpoch: 1,
        acceptedAtMillis: 1_400, targetHostLeaseGeneration: 9,
      },
    }
    const first = await host.dispatchAuthorizedRequest(request, context)
    const duplicate = await host.dispatchAuthorizedRequest(request, context)
    expect(first).toMatchObject({ status: 'rejected', error: { code: 'SESSION_STATE_CHANGED' } })
    expect(duplicate).toMatchObject({ status: 'rejected', error: { code: 'SESSION_STATE_CHANGED' } })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0]![0]).toMatchObject({ payload: {
      sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }],
    } })
    ledger.close()
  })
})
