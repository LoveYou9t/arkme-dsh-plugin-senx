import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createArkmeHostApi, dispatchArkmeHostOperation } from '../src/host-api.js'
import { createArkmeSdk } from '../src/sdk/index.js'
import type { DshRemoteHostFacade, DshRemoteStatus } from '../src/dsh-remote/types.js'

const status: DshRemoteStatus = {
  contractVersion: 1, available: true, enabled: false, connected: false,
  hostGeneration: 1, capabilities: ['workspace.list'], bindings: [], revision: 1,
}

function remoteHost(): DshRemoteHostFacade {
  return {
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    getStatus: vi.fn(() => status), setEnabled: vi.fn(async enabled => ({ ...status, enabled })),
    createPairingAttempt: vi.fn(async () => ({
      pairingRef: 'pairing-test-01', pairingChannelRef: 'channel-test-01', qrPayload: '{}',
      pairingCode: '0123-ABCD', hostKeyFingerprint: 'fingerprint',
      expiresAtMillis: 10_000, runtimeRef: 'runtime-test-01',
    })),
    cancelPairingAttempt: vi.fn(async () => undefined), listBindings: vi.fn(async () => []),
    revokeBinding: vi.fn(async () => undefined), renameDesktop: vi.fn(async () => status),
    subscribe: vi.fn(() => () => undefined),
  }
}

function dispatch(host: DshRemoteHostFacade, operation: Parameters<typeof dispatchArkmeHostOperation>[1], params: Record<string, unknown>) {
  return dispatchArkmeHostOperation(
    {} as never, operation, params, undefined, undefined, undefined, undefined, undefined, host,
  )
}

describe('restricted DSH remote Host API and SDK', () => {
  it('exposes only the frozen remote management facade and validates mutation fields', async () => {
    const host = remoteHost()
    await expect(dispatch(host, 'remote.getStatus', {})).resolves.toEqual(status)
    await expect(dispatch(host, 'remote.setEnabled', { enabled: true })).resolves.toMatchObject({ enabled: true })
    await expect(dispatch(host, 'remote.createPairingAttempt', {})).resolves.toMatchObject({ pairingRef: 'pairing-test-01' })
    await dispatch(host, 'remote.cancelPairingAttempt', { pairingRef: ' pairing-test-01 ' })
    await dispatch(host, 'remote.revokeBinding', { bindingRef: ' binding-test-01 ' })
    await dispatch(host, 'remote.renameDesktop', { displayName: '工作电脑' })
    expect(host.cancelPairingAttempt).toHaveBeenCalledWith('pairing-test-01')
    expect(host.revokeBinding).toHaveBeenCalledWith('binding-test-01')
    await expect(dispatch(host, 'remote.setEnabled', { enabled: 'true' })).rejects.toMatchObject({ code: 'boolean-param-required' })
    await expect(dispatchArkmeHostOperation({} as never, 'remote.getStatus', {})).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(dispatch(host, 'remote.apiProxy' as never, { method: 'sessions.prompt' })).rejects.toMatchObject({ code: 'operation-unknown' })
  })

  it('requires a same-page Origin for remote mutations but permits read-only status', async () => {
    const host = remoteHost()
    const server = createServer(createArkmeHostApi({} as never, {
      expectedPort: 0, allowNonLoopback: false, remoteHost: () => host,
    }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server address missing')
    const endpoint = `http://127.0.0.1:${String(address.port)}/arkme-self/api`
    try {
      const read = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'remote.getStatus' }),
      })
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({ ok: true, value: { contractVersion: 1 } })
      const mutation = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'remote.setEnabled', params: { enabled: true } }),
      })
      expect(mutation.status).toBe(403)
      expect(await mutation.json()).toMatchObject({ ok: false, error: { code: 'origin-required' } })
    } finally { server.close(); await once(server, 'close') }
  })

  it('maps the typed SDK to exact remote.* calls and rejects empty opaque refs locally', async () => {
    const calls: Array<{ operation: string; params?: Record<string, unknown> }> = []
    const sdk = createArkmeSdk({ fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { operation: string; params?: Record<string, unknown> }
      calls.push(request)
      const value = request.operation === 'remote.createPairingAttempt'
        ? { pairingRef: 'pairing-test-01' }
        : request.operation === 'remote.listBindings' ? [] : status
      return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    } })
    await sdk.remoteStatus()
    await sdk.setRemoteEnabled(true)
    await sdk.createRemotePairingAttempt()
    await sdk.cancelRemotePairingAttempt(' pairing-test-01 ')
    await sdk.remoteBindings()
    await sdk.revokeRemoteBinding(' binding-test-01 ')
    await sdk.renameRemoteDesktop(' 工作电脑 ')
    expect(calls).toEqual([
      { operation: 'remote.getStatus' },
      { operation: 'remote.setEnabled', params: { enabled: true } },
      { operation: 'remote.createPairingAttempt' },
      { operation: 'remote.cancelPairingAttempt', params: { pairingRef: 'pairing-test-01' } },
      { operation: 'remote.listBindings' },
      { operation: 'remote.revokeBinding', params: { bindingRef: 'binding-test-01' } },
      { operation: 'remote.renameDesktop', params: { displayName: '工作电脑' } },
    ])
    await expect(sdk.cancelRemotePairingAttempt(' ')).rejects.toThrow(/must not be empty/)
    await expect(sdk.revokeRemoteBinding(' ')).rejects.toThrow(/must not be empty/)
  })
})
