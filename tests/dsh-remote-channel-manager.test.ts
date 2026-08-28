import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSecureValueStore } from '../src/keychain-store.js'
import { DshRemoteHostChannelManager, dshRemoteControlAgreementTranscript } from '../src/dsh-remote/channel-manager.js'
import { DesktopCredentialBroker } from '../src/dsh-remote/desktop-credential-broker.js'
import { DshRemoteError } from '../src/dsh-remote/errors.js'
import {
  canonicalJson,
  deriveDirectionalKeys,
  deriveX25519,
  generateEd25519DeviceKey,
  generateX25519Key,
  pairingKeyConfirmation,
  signEd25519,
} from '../src/dsh-remote/crypto.js'
import { decryptDshRemotePayload, encryptDshRemotePayload } from '../src/dsh-remote/protocol-v1.js'
import type {
  DshRemoteBindingProjection,
  DshRemoteControlPlane,
  DshRemoteGrantClaims,
  DshRemoteRealtimePayload,
  DshRemoteRealtimeTransport,
  DshRemoteTrustedEventMetadata,
} from '../src/dsh-remote/types.js'

class MemorySecrets implements ArkmeSecureValueStore {
  private readonly values = new Map<string, string>()
  async read(account: string) { return this.values.get(account) }
  async write(account: string, value: string) { this.values.set(account, value) }
  async delete(account: string) { this.values.delete(account) }
}

function compactGrant(claims: DshRemoteGrantClaims, kid: string, privateJwk: JsonWebKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${body}.${signEd25519(privateJwk, `${header}.${body}`)}`
}

class FakeRealtime implements DshRemoteRealtimeTransport {
  readonly published: Array<{ channelRef: string; direction: string; payload: DshRemoteRealtimePayload }> = []
  readonly afterSequences: Array<number | undefined> = []
  onEvent: ((payload: DshRemoteRealtimePayload, metadata: DshRemoteTrustedEventMetadata) => void) | undefined
  rejectNextOversizedProjection = false
  rejectNextReplay = false
  subscribeDisconnect() { return () => undefined }
  async connect() {}
  async disconnect() {}
  async registerHost() { return { serviceLeaseGeneration: 9 } }
  async unregisterHost() {}
  async authorizeChannel() {
    return { authorizationRef: 'host-authorization-01', remoteAuthEpoch: 3, serviceLeaseGeneration: 9, expiresAtMillis: 1_120_000 }
  }
  async subscribe(input: Parameters<DshRemoteRealtimeTransport['subscribe']>[0]) {
    this.afterSequences.push(input.afterSequence)
    if (this.rejectNextReplay && input.afterSequence !== undefined) {
      this.rejectNextReplay = false
      throw new DshRemoteError('REPLAY_GAP', 'replay window expired', true)
    }
    this.onEvent = input.onEvent
    return () => { this.onEvent = undefined }
  }
  async publish(input: Parameters<DshRemoteRealtimeTransport['publish']>[0]) {
    if (this.rejectNextOversizedProjection) {
      this.rejectNextOversizedProjection = false
      throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'frame too large', false, { frameTooLarge: true })
    }
    this.published.push({ channelRef: input.channelRef, direction: input.direction, payload: input.payload })
    return { sequence: this.published.length }
  }
}

describe('Host control Channel key lifecycle', () => {
  it('uses fresh signed X25519 on reconnect and only dispatches after controller key confirmation', async () => {
    const nowMillis = 1_000_000
    const issuer = generateEd25519DeviceKey('issuer')
    const host = generateEd25519DeviceKey('1')
    const controller = generateEd25519DeviceKey('1-controller')
    const binding: DshRemoteBindingProjection = {
      bindingRef: 'binding-test-01', controllerCredentialRef: 'credential-controller-01',
      controllerDisplayName: 'Phone', controllerPlatform: 'ios', revision: 1, status: 'active',
      scopes: ['session.read'], boundAtMillis: 1,
    }
    const claims: DshRemoteGrantClaims = {
      iss: 'jotmo-backend/dsh-remote', aud: 'jotmo-realtime/remote-channel', sub: binding.bindingRef,
      jti: 'grant-host-test-01', iat: 1_000, nbf: 970, exp: 1_120, user_id: 1, client_id: 2,
      grant_kind: 'control', channel_ref: 'remotech-runtime-test-01', runtime_ref: 'runtime-test-01',
      host_profile_ref: 'web', host_client_ref: 'host-client-test', credential_ref: 'credential-host-01',
      key_epoch: 1, sender_role: 'host', allowed_directions: ['response', 'snapshot', 'event'],
      scope: ['session.read'], subject_revisions: { credential: 1, binding: 1, runtime: 1, global: 1 },
      cnf: { key_fingerprint: host.keyFingerprint, public_key: host.publicKey },
    }
    const grant = compactGrant(claims, 'issuer-test', issuer.privateJwk)
    const broker = new DesktopCredentialBroker(new MemorySecrets())
    const rootSecret = Buffer.alloc(32, 7)
    await broker.putBindingRoot({
      accountId: '1', bindingRef: binding.bindingRef, rootSecret,
      controllerPublicKey: controller.publicKey, controllerKeyFingerprint: controller.keyFingerprint,
      controllerToHost: Buffer.alloc(32, 1), hostToController: Buffer.alloc(32, 2),
    })
    // This Runtime did not perform the original pairing. It must bootstrap its
    // pairwise channel from the Desktop-wide Binding root, not require a second
    // QR/code flow or reuse another Runtime's transport cursor.
    const realtime = new FakeRealtime()
    const dispatch = vi.fn(async request => ({
      protocol: 'dsh.remote' as const, protocol_major: 1 as const, kind: 'response' as const,
      request_ref: (request as { request_ref: string }).request_ref, status: 'completed' as const,
      host_generation: 1, issued_at: nowMillis, operation: 'session.history' as const,
      body: { result: { ok: true } }, result: { ok: true },
    }))
    const manager = new DshRemoteHostChannelManager({
      accountId: '1', userId: 1, clientId: 2, profileRef: 'web', hostClientRef: 'host-client-test',
      runtimeRef: claims.runtime_ref, credentialRef: claims.credential_ref,
      identity: host, serviceLeaseGeneration: 9, grantSigningKeys: { 'issuer-test': issuer.publicKey },
      controlPlane: { requestChannelGrant: async () => ({ grant, channelRef: claims.channel_ref }) } as unknown as DshRemoteControlPlane,
      realtime, credentialBroker: broker, dispatch, now: () => nowMillis,
    })
    await manager.open(binding)
    const firstInit = realtime.published[0]!.payload as Record<string, unknown>
    expect(firstInit).toMatchObject({ kind: 'host-key-init', channel_ref: claims.channel_ref, host_remote_auth_epoch: 3 })
    expect(manager.status(binding.bindingRef)?.ready).toBe(false)

    // The real EventBus broadcasts a publisher's own event back to its
    // subscription. A Host echo must not tear down the control channel.
    realtime.onEvent?.(firstInit, {
      senderRole: 'host', senderCredentialRef: claims.credential_ref,
      authorizationRef: 'host-authorization-01', subjectRevision: 1, remoteAuthEpoch: 3,
      acceptedAtMillis: nowMillis, targetHostLeaseGeneration: 9, transportSequence: 1,
    })
    await vi.waitFor(() => { expect(manager.status(binding.bindingRef)).toBeDefined() })

    const controllerEphemeral = generateX25519Key()
    const transcript = dshRemoteControlAgreementTranscript({
      bindingRef: binding.bindingRef, bindingRevision: 1, runtimeRef: claims.runtime_ref, channelRef: claims.channel_ref,
      hostAuthorizationRef: 'host-authorization-01', hostRemoteAuthEpoch: 3,
      controllerAuthorizationRef: 'controller-authorization-01', controllerRemoteAuthEpoch: 4,
      hostEphemeralPublicKey: String(firstInit.host_ephemeral_public_key),
      controllerEphemeralPublicKey: controllerEphemeral.publicKey, nonce: String(firstInit.nonce),
    })
    const shared = deriveX25519(controllerEphemeral.privateJwk, String(firstInit.host_ephemeral_public_key))
    const keys = deriveDirectionalKeys(shared, rootSecret, transcript)
    const unsigned = {
      protocol: 'dsh.remote-key', protocol_major: 1, kind: 'controller-key-confirm',
      binding_ref: binding.bindingRef, binding_revision: 1, runtime_ref: claims.runtime_ref, channel_ref: claims.channel_ref,
      host_authorization_ref: 'host-authorization-01', host_remote_auth_epoch: 3,
      controller_authorization_ref: 'controller-authorization-01', controller_remote_auth_epoch: 4,
      host_ephemeral_public_key: firstInit.host_ephemeral_public_key,
      controller_ephemeral_public_key: controllerEphemeral.publicKey,
      controller_key_fingerprint: controller.keyFingerprint, nonce: firstInit.nonce, next_key_epoch: 2,
      confirmation: pairingKeyConfirmation(keys.confirmation, transcript, 'controller'),
    }
    realtime.onEvent?.({ ...unsigned, signature: signEd25519(controller.privateJwk, canonicalJson(unsigned)) }, {
      senderRole: 'controller', senderCredentialRef: binding.controllerCredentialRef,
      authorizationRef: 'controller-authorization-01', subjectRevision: 1, remoteAuthEpoch: 4,
      acceptedAtMillis: nowMillis, targetHostLeaseGeneration: 9, transportSequence: 2,
    })
    await vi.waitFor(() => { expect(manager.status(binding.bindingRef)?.ready).toBe(true) })

    const liveProjection = {
      protocol: 'dsh.remote', protocol_major: 1, kind: 'event', request_ref: 'event-live-test-01',
      host_generation: 1, issued_at: nowMillis, operation: 'session.history',
      body: { session_ref: 'session-test-01', entries: [] }, session_seq: 8,
    }
    await manager.publishProjectionEvent(liveProjection, 'event-live-test-01')
    expect(realtime.published.at(-1)?.direction).toBe('event')
    expect(decryptDshRemotePayload(keys.hostToController, realtime.published.at(-1)!.payload as never, {
      keyEpoch: 2, direction: 'host-to-controller',
    })).toEqual(liveProjection)

    realtime.rejectNextOversizedProjection = true
    await manager.publishProjectionEvent({ ...liveProjection, request_ref: 'event-oversized-test-01' }, 'event-oversized-test-01')
    expect(manager.status(binding.bindingRef)?.ready).toBe(true)

    const request = { request_ref: 'request-test-01' }
    realtime.onEvent?.(encryptDshRemotePayload(keys.controllerToHost, request, {
      keyEpoch: 2, direction: 'controller-to-host', nonce: Buffer.alloc(24, 5),
    }), {
      senderRole: 'controller', senderCredentialRef: binding.controllerCredentialRef,
      authorizationRef: 'controller-authorization-01', subjectRevision: 1, remoteAuthEpoch: 4,
      acceptedAtMillis: nowMillis, targetHostLeaseGeneration: 9, transportSequence: 3,
    })
    await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledTimes(1) })
    const response = realtime.published.at(-1)!.payload
    expect(decryptDshRemotePayload(keys.hostToController, response as never, {
      keyEpoch: 2, direction: 'host-to-controller',
    })).toMatchObject({ request_ref: 'request-test-01', status: 'completed' })

    realtime.rejectNextReplay = true
    await manager.open(binding)
    expect(realtime.afterSequences).toEqual([0, 3, undefined])
    const secondInit = realtime.published.at(-1)!.payload as Record<string, unknown>
    expect(secondInit.host_ephemeral_public_key).not.toBe(firstInit.host_ephemeral_public_key)
    await manager.closeAll()
  })
})
