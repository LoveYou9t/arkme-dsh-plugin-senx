import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSecureValueStore } from '../src/keychain-store.js'
import { DshApiProxyAdapter } from '../src/dsh-remote/api-proxy-adapter.js'
import { DesktopCredentialBroker } from '../src/dsh-remote/desktop-credential-broker.js'
import {
  canonicalJson,
  deriveDirectionalKeys,
  deriveX25519,
  generateEd25519DeviceKey,
  generateX25519Key,
  pairingKeyConfirmation,
  pairingTranscript,
  sha256,
  signEd25519,
} from '../src/dsh-remote/crypto.js'
import { ArkmeRemoteRealtimeHost } from '../src/dsh-remote/host.js'
import { DshRemoteRuntimeStore } from '../src/dsh-remote/runtime-store.js'
import type {
  DshRemoteBindingProjection,
  DshRemoteConfirmedPairing,
  DshRemoteControlPlane,
  DshRemoteCreatedPairingAttempt,
  DshRemoteGrantClaims,
  DshRemoteRealtimePayload,
  DshRemoteRealtimeTransport,
  DshRemoteTrustedEventMetadata,
} from '../src/dsh-remote/types.js'

class MemorySecrets implements ArkmeSecureValueStore {
  readonly values = new Map<string, string>()
  async read(account: string) { return this.values.get(account) }
  async write(account: string, value: string) { this.values.set(account, value) }
  async delete(account: string) { this.values.delete(account) }
}

function compactGrant(claims: DshRemoteGrantClaims, kid: string, privateJwk: JsonWebKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${body}.${signEd25519(privateJwk, `${header}.${body}`)}`
}

class PairingRealtime implements DshRemoteRealtimeTransport {
  readonly listeners = new Map<string, (payload: DshRemoteRealtimePayload, metadata: DshRemoteTrustedEventMetadata) => void>()
  readonly published: Array<{ channelRef: string; direction: string; payload: DshRemoteRealtimePayload }> = []
  subscribeDisconnect() { return () => undefined }
  async connect() {}
  async disconnect() {}
  async registerHost() { return { serviceLeaseGeneration: 9 } }
  async unregisterHost() {}
  async authorizeChannel() {
    return { authorizationRef: 'authorization-host-01', remoteAuthEpoch: 1, serviceLeaseGeneration: 9, expiresAtMillis: 1_120_000 }
  }
  async subscribe(input: Parameters<DshRemoteRealtimeTransport['subscribe']>[0]) {
    this.listeners.set(input.channelRef, input.onEvent)
    return () => { this.listeners.delete(input.channelRef) }
  }
  async publish(input: Parameters<DshRemoteRealtimeTransport['publish']>[0]) {
    this.published.push({ channelRef: input.channelRef, direction: input.direction, payload: input.payload })
    return { sequence: this.published.length }
  }
}

describe('Host Pairing Channel lifecycle', () => {
  it('shows a ticket only after Host readiness and promotes confirmed keys to the final Binding+Runtime channel', async () => {
    const nowMillis = 1_000_000
    const directory = await mkdtemp(join(tmpdir(), 'arkme host pairing '))
    const issuer = generateEd25519DeviceKey('issuer')
    const hostIdentity = generateEd25519DeviceKey('1')
    const controllerIdentity = generateEd25519DeviceKey('controller')
    const runtimeRef = 'runtime-host-test-01'
    const credentialRef = 'credential-host-test-01'
    const binding: DshRemoteBindingProjection = {
      bindingRef: 'binding-host-test-01', controllerCredentialRef: 'credential-controller-test-01',
      controllerDisplayName: 'Phone', controllerPlatform: 'ios', revision: 1, status: 'active',
      scopes: ['session.read'], boundAtMillis: nowMillis,
    }
    const controlChannelRef = 'remotech-control-test-01'
    let pairingRef = ''
    let pairingChannelRef = ''
    let challenge = ''
    const createPairingAttempt = vi.fn(async (_desktopRef: string, input: Record<string, unknown>): Promise<DshRemoteCreatedPairingAttempt> => {
      pairingRef = 'pairing-host-test-01'
      pairingChannelRef = String(input.pairing_channel_ref)
      challenge = String(input.challenge)
      const claims: DshRemoteGrantClaims = {
        iss: 'jotmo-backend/dsh-remote', aud: 'jotmo-realtime/remote-channel', sub: pairingRef,
        jti: 'grant-pairing-host-01', iat: 1_000, nbf: 970, exp: 1_120, user_id: 1, client_id: 2,
        grant_kind: 'pairing', channel_ref: pairingChannelRef, runtime_ref: runtimeRef,
        host_profile_ref: 'web', host_client_ref: 'host-client-test', credential_ref: credentialRef,
        key_epoch: 1, sender_role: 'host', allowed_directions: ['pairing_confirm'], scope: [],
        subject_revisions: { credential: 1, pairing: 1, runtime: 1, global: 1 },
        cnf: { key_fingerprint: hostIdentity.keyFingerprint, public_key: hostIdentity.publicKey },
      }
      return {
        pairing: { pairing_ref: pairingRef, pairing_channel_ref: pairingChannelRef, challenge, expires_at: nowMillis + 600_000 },
        grant: { grant: compactGrant(claims, 'issuer-test', issuer.privateJwk), channelRef: pairingChannelRef },
      }
    })
    const confirmedGrantClaims: DshRemoteGrantClaims = {
      iss: 'jotmo-backend/dsh-remote', aud: 'jotmo-realtime/remote-channel', sub: binding.bindingRef,
      jti: 'grant-control-host-01', iat: 1_000, nbf: 970, exp: 1_120, user_id: 1, client_id: 2,
      grant_kind: 'control', channel_ref: controlChannelRef, runtime_ref: runtimeRef,
      host_profile_ref: 'web', host_client_ref: 'host-client-test', credential_ref: credentialRef,
      key_epoch: 1, sender_role: 'host', allowed_directions: ['response', 'snapshot', 'event'],
      scope: binding.scopes, subject_revisions: { credential: 1, binding: 1, runtime: 1, global: 1 },
      cnf: { key_fingerprint: hostIdentity.keyFingerprint, public_key: hostIdentity.publicKey },
    }
    const confirmedGrant = { grant: compactGrant(confirmedGrantClaims, 'issuer-test', issuer.privateJwk), channelRef: controlChannelRef }
    const confirmPairing = vi.fn(async (): Promise<DshRemoteConfirmedPairing> => ({
      pairing: { pairing_ref: pairingRef, status: 'active' }, binding, grant: confirmedGrant,
    }))
    const controlPlane = {
      createPairingAttempt, confirmPairing,
      requestChannelGrant: async () => confirmedGrant,
    } as unknown as DshRemoteControlPlane
    const secrets = new MemorySecrets()
    const broker = new DesktopCredentialBroker(secrets)
    const realtime = new PairingRealtime()
    const host = new ArkmeRemoteRealtimeHost({
      featureEnabled: true, environment: 'test', profileRef: 'web', hostClientRef: 'host-client-test',
      readSession: async () => ({ userId: 1, clientId: 2 }), credentialBroker: broker,
      runtimeStore: new DshRemoteRuntimeStore(directory), controlPlane, realtime,
      apiProxy: new DshApiProxyAdapter({}), ledgerForAccount: () => { throw new Error('unused') },
      grantSigningKeys: { 'issuer-test': issuer.publicKey }, now: () => nowMillis,
    })
    Object.assign(host, {
      accountId: '1', userId: 1, clientId: 2, identity: hostIdentity, credentialRef,
      runtime: {
        runtimeRef, desktopRef: 'desktop-host-test-01', profileRef: 'web', accountId: '1',
        remoteEnabled: true, hostGeneration: 1, capabilities: [], updatedAtMillis: nowMillis,
      },
      started: true, connected: true, serviceLeaseGeneration: 9, bindings: [],
    })
    const pending = host.createPairingAttempt()
    expect(host.getStatus().pairingAttempt).toBeUndefined()
    const ticket = await pending
    expect(realtime.listeners.has(ticket.pairingChannelRef)).toBe(true)
    expect(host.getStatus().pairingAttempt?.pairingRef).toBe(ticket.pairingRef)

    const qr = JSON.parse(ticket.qrPayload) as Record<string, unknown>
    const controllerEphemeral = generateX25519Key()
    const controllerClaims: DshRemoteGrantClaims = {
      iss: 'jotmo-backend/dsh-remote', aud: 'jotmo-realtime/remote-channel', sub: pairingRef,
      jti: 'grant-pairing-controller-01', iat: 1_000, nbf: 970, exp: 1_120, user_id: 1, client_id: 3,
      grant_kind: 'pairing', channel_ref: pairingChannelRef, runtime_ref: runtimeRef,
      host_profile_ref: 'web', host_client_ref: 'host-client-test', credential_ref: binding.controllerCredentialRef,
      key_epoch: 1, sender_role: 'controller', allowed_directions: ['pairing_claim'], scope: [],
      subject_revisions: { credential: 1, pairing: 1, runtime: 1, global: 1 },
      cnf: { key_fingerprint: controllerIdentity.keyFingerprint, public_key: controllerIdentity.publicKey },
    }
    const claimNonce = 'claim-host-test-01'
    const transcript = pairingTranscript({
      environment: 'test', pairingRef, challenge, claimNonce,
      hostFingerprint: hostIdentity.keyFingerprint, controllerFingerprint: controllerIdentity.keyFingerprint,
    })
    const shared = deriveX25519(controllerEphemeral.privateJwk, String(qr.host_ephemeral_public_key))
    const keys = deriveDirectionalKeys(shared, sha256(challenge), transcript)
    const unsignedClaim = {
      protocol: 'dsh.remote-pairing', protocol_major: 1, kind: 'controller-claim', pairing_ref: pairingRef,
      runtime_ref: runtimeRef, challenge, claim_nonce: claimNonce,
      controller_grant: compactGrant(controllerClaims, 'issuer-test', issuer.privateJwk),
      controller_ephemeral_public_key: controllerEphemeral.publicKey, secret_kind: 'qr-challenge',
      confirmation: pairingKeyConfirmation(keys.confirmation, transcript, 'controller'),
    }
    realtime.listeners.get(pairingChannelRef)?.({
      ...unsignedClaim, signature: signEd25519(controllerIdentity.privateJwk, canonicalJson(unsignedClaim)),
    }, {
      senderRole: 'controller', senderCredentialRef: binding.controllerCredentialRef,
      authorizationRef: 'authorization-controller-01', subjectRevision: 1, remoteAuthEpoch: 2,
      acceptedAtMillis: nowMillis, targetHostLeaseGeneration: 9,
    })
    await vi.waitFor(() => { expect(confirmPairing).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(host.getStatus().bindings).toHaveLength(1) })
    expect(host.getStatus().pairingAttempt).toBeUndefined()
    const stored = await broker.channelKeys({
      accountId: '1', bindingRef: binding.bindingRef, runtimeRef, channelRef: controlChannelRef,
    })
    expect(stored).toMatchObject({
      controllerPublicKey: controllerIdentity.publicKey,
      controllerKeyFingerprint: controllerIdentity.keyFingerprint,
    })
    expect(realtime.published.find(item => item.direction === 'pairing_confirm')?.payload).toMatchObject({
      kind: 'host-key-confirm', host_public_signing_key: hostIdentity.publicKey,
    })
    await host.stop()
  })
})
