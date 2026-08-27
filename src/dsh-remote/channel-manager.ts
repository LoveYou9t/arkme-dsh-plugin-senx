import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto'
import { DesktopCredentialBroker } from './desktop-credential-broker.js'
import {
  canonicalJson,
  deriveDirectionalKeys,
  deriveX25519,
  encodeBase64Url,
  generateX25519Key,
  pairingKeyConfirmation,
  signEd25519,
  verifyEd25519,
  verifyRemoteGrant,
} from './crypto.js'
import { DshRemoteError } from './errors.js'
import { decryptDshRemotePayload, encryptDshRemotePayload } from './protocol-v1.js'
import type {
  DshRemoteBindingProjection,
  DshRemoteCipherEnvelope,
  DshRemoteControlPlane,
  DshRemoteDeviceKeyMaterial,
  DshRemoteGrantClaims,
  DshRemoteIssuedGrant,
  DshRemoteRealtimeTransport,
  DshRemoteResponse,
  DshRemoteTrustedEventMetadata,
} from './types.js'

interface KeyAgreement {
  hostPrivateJwk: NodeJsonWebKey
  hostEphemeralPublicKey: string
  nonce: string
  nextEpoch: number
  timer: ReturnType<typeof setTimeout>
}

interface ActiveChannel {
  binding: DshRemoteBindingProjection
  claims: DshRemoteGrantClaims
  authorizationRef: string
  remoteAuthEpoch: number
  serviceLeaseGeneration: number
  keyEpoch: number
  rootSecret: Buffer
  controllerPublicKey: string
  controllerKeyFingerprint: string
  controllerToHost: Buffer
  hostToController: Buffer
  unsubscribe: () => void
  renewTimer?: ReturnType<typeof setTimeout>
  rotateTimer?: ReturnType<typeof setTimeout>
  agreement?: KeyAgreement
  ready: boolean
  controller: AbortController
}

export interface DshRemoteHostChannelManagerOptions {
  accountId: string
  userId: number
  clientId: number
  profileRef: string
  hostClientRef: string
  runtimeRef: string
  credentialRef: string
  identity: DshRemoteDeviceKeyMaterial
  serviceLeaseGeneration: number
  grantSigningKeys: Readonly<Record<string, string>>
  controlPlane: DshRemoteControlPlane
  realtime: DshRemoteRealtimeTransport
  credentialBroker: DesktopCredentialBroker
  dispatch: (request: unknown, context: {
    bindingRef: string
    serviceLeaseGeneration: number
    metadata: DshRemoteTrustedEventMetadata
  }) => Promise<DshRemoteResponse>
  now?: () => number
}

interface HostKeyInit extends Record<string, unknown> {
  protocol: 'dsh.remote-key'
  protocol_major: 1
  kind: 'host-key-init'
  direction: 'host-to-controller'
  binding_ref: string
  binding_revision: number
  runtime_ref: string
  channel_ref: string
  host_authorization_ref: string
  host_remote_auth_epoch: number
  host_ephemeral_public_key: string
  host_key_fingerprint: string
  nonce: string
  next_key_epoch: number
  issued_at: number
  signature: string
}

function agreementTranscript(input: {
  bindingRef: string
  bindingRevision: number
  runtimeRef: string
  channelRef: string
  hostAuthorizationRef: string
  hostRemoteAuthEpoch: number
  controllerAuthorizationRef: string
  controllerRemoteAuthEpoch: number
  hostEphemeralPublicKey: string
  controllerEphemeralPublicKey: string
  nonce: string
}): string {
  return [
    'dsh.remote/v1/control-key-agreement',
    `binding_ref=${input.bindingRef}`,
    `binding_revision=${String(input.bindingRevision)}`,
    `runtime_ref=${input.runtimeRef}`,
    `channel_ref=${input.channelRef}`,
    `host_authorization_ref=${input.hostAuthorizationRef}`,
    `host_remote_auth_epoch=${String(input.hostRemoteAuthEpoch)}`,
    `controller_authorization_ref=${input.controllerAuthorizationRef}`,
    `controller_remote_auth_epoch=${String(input.controllerRemoteAuthEpoch)}`,
    `host_ephemeral_public_key=${input.hostEphemeralPublicKey}`,
    `controller_ephemeral_public_key=${input.controllerEphemeralPublicKey}`,
    `nonce=${input.nonce}`,
  ].join('\n')
}

function rawPayload(value: Record<string, unknown>): DshRemoteCipherEnvelope {
  return value as unknown as DshRemoteCipherEnvelope
}

/**
 * Binding+Runtime+signed-Grant-channel owner. Every connection and 30-minute
 * rotation uses newly authenticated X25519 ephemerals; persisted symmetric
 * keys are never reused as a reconnect handshake.
 */
export class DshRemoteHostChannelManager {
  private readonly channels = new Map<string, ActiveChannel>()
  private readonly now: () => number

  constructor(private readonly options: DshRemoteHostChannelManagerOptions) {
    this.now = options.now ?? Date.now
  }

  async open(binding: DshRemoteBindingProjection, issuedGrant?: DshRemoteIssuedGrant): Promise<{ channelRef: string; ready: boolean }> {
    if (binding.status !== 'active') throw new DshRemoteError('BINDING_REVOKED', '远控绑定已失效')
    const issued = issuedGrant ?? await this.options.controlPlane.requestChannelGrant({
      grant_kind: 'control', subject_ref: binding.bindingRef, runtime_ref: this.options.runtimeRef,
      credential_ref: this.options.credentialRef, sender_role: 'host',
    })
    const claims = verifyRemoteGrant(issued.grant, this.options.grantSigningKeys, {
      issuer: 'jotmo-backend/dsh-remote', audience: 'jotmo-realtime/remote-channel',
      nowSeconds: Math.floor(this.now() / 1000),
    })
    if (claims.grant_kind !== 'control' || claims.sender_role !== 'host' || claims.sub !== binding.bindingRef
      || claims.user_id !== this.options.userId || claims.client_id !== this.options.clientId
      || claims.host_profile_ref !== this.options.profileRef || claims.host_client_ref !== this.options.hostClientRef
      || claims.runtime_ref !== this.options.runtimeRef || claims.credential_ref !== this.options.credentialRef
      || claims.subject_revisions.binding !== binding.revision
      || claims.cnf.key_fingerprint !== this.options.identity.keyFingerprint || claims.cnf.public_key !== this.options.identity.publicKey
      || !claims.allowed_directions.includes('response')
      || claims.scope.length !== binding.scopes.length || claims.scope.some(scope => !binding.scopes.includes(scope))) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Host Control Grant 与本机 Binding/Runtime 不匹配')
    }
    if (issued.channelRef !== undefined && issued.channelRef !== claims.channel_ref) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Backend Control Grant 频道摘要与签名 claims 不匹配')
    }
    // The signed Grant's final pairwise channel is the only routing owner.
    const material = await this.options.credentialBroker.channelKeys({
      accountId: this.options.accountId, bindingRef: binding.bindingRef,
      runtimeRef: this.options.runtimeRef, channelRef: claims.channel_ref,
    })
    if (material === undefined) throw new DshRemoteError('HOST_CHANNEL_NOT_READY', '该 Binding/Runtime 尚未由配对流程提升方向密钥', true)
    await this.close(binding.bindingRef)
    const controller = new AbortController()
    const authorization = await this.options.realtime.authorizeChannel({
      grant: issued.grant, claims,
      signProof: async transcript => signEd25519(this.options.identity.privateJwk, transcript),
      signal: controller.signal,
    })
    if (authorization.serviceLeaseGeneration !== this.options.serviceLeaseGeneration) {
      controller.abort()
      throw new DshRemoteError('HOST_GENERATION_STALE', 'Control Grant 授权属于旧 Host lease', true)
    }
    const channel: ActiveChannel = {
      binding, claims, authorizationRef: authorization.authorizationRef, remoteAuthEpoch: authorization.remoteAuthEpoch,
      serviceLeaseGeneration: authorization.serviceLeaseGeneration,
      keyEpoch: material.keyEpoch, rootSecret: material.rootSecret,
      controllerPublicKey: material.controllerPublicKey, controllerKeyFingerprint: material.controllerKeyFingerprint,
      controllerToHost: material.controllerToHost, hostToController: material.hostToController,
      unsubscribe: () => undefined, ready: false, controller,
    }
    channel.unsubscribe = await this.options.realtime.subscribe({
      channelRef: claims.channel_ref, authorizationRef: authorization.authorizationRef,
      onEvent: (payload, metadata) => {
        void this.handle(channel, payload as DshRemoteCipherEnvelope, metadata).catch(() => {
          void this.close(channel.binding.bindingRef)
        })
      }, signal: controller.signal,
    })
    this.channels.set(binding.bindingRef, channel)
    this.scheduleRenew(channel)
    await this.startKeyAgreement(channel)
    return { channelRef: claims.channel_ref, ready: false }
  }

  status(bindingRef: string): { channelRef: string; runtimeRef: string; ready: boolean; keyEpoch: number } | undefined {
    const channel = this.channels.get(bindingRef)
    return channel === undefined ? undefined : {
      channelRef: channel.claims.channel_ref, runtimeRef: this.options.runtimeRef, ready: channel.ready, keyEpoch: channel.keyEpoch,
    }
  }

  async close(bindingRef: string): Promise<void> {
    const channel = this.channels.get(bindingRef)
    if (channel === undefined) return
    this.channels.delete(bindingRef)
    channel.ready = false
    channel.controller.abort()
    channel.unsubscribe()
    if (channel.renewTimer !== undefined) clearTimeout(channel.renewTimer)
    if (channel.rotateTimer !== undefined) clearTimeout(channel.rotateTimer)
    if (channel.agreement !== undefined) clearTimeout(channel.agreement.timer)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.channels.keys()].map(async bindingRef => await this.close(bindingRef)))
  }

  private async handle(channel: ActiveChannel, payload: DshRemoteCipherEnvelope, metadata: DshRemoteTrustedEventMetadata): Promise<void> {
    if (this.channels.get(channel.binding.bindingRef) !== channel) return
    // Realtime broadcasts every Channel event to every subscriber, including
    // the publisher. Host key-init/confirmation/response echoes are transport
    // evidence only and must never tear down the Host's own control channel.
    if (metadata.senderRole === 'host') return
    if (metadata.targetHostLeaseGeneration !== channel.serviceLeaseGeneration || metadata.senderRole !== 'controller'
      || metadata.senderCredentialRef !== channel.binding.controllerCredentialRef
      || metadata.subjectRevision !== channel.binding.revision) {
      await this.close(channel.binding.bindingRef)
      return
    }
    if (!channel.ready) {
      await this.confirmKeyAgreement(channel, payload as unknown as Record<string, unknown>, metadata)
      return
    }
    let decoded: unknown
    try {
      decoded = decryptDshRemotePayload<unknown>(channel.controllerToHost, payload, {
        keyEpoch: channel.keyEpoch, direction: 'controller-to-host',
      })
    } catch { return }
    const result = await this.options.dispatch(decoded, {
      bindingRef: channel.binding.bindingRef, serviceLeaseGeneration: channel.serviceLeaseGeneration, metadata,
    })
    await this.options.realtime.publish({
      channelRef: channel.claims.channel_ref, authorizationRef: channel.authorizationRef,
      commandId: `response_${result.request_ref}`,
      direction: 'response',
      payload: encryptDshRemotePayload(channel.hostToController, result, {
        keyEpoch: channel.keyEpoch, direction: 'host-to-controller',
      }), signal: channel.controller.signal,
    })
  }

  private async startKeyAgreement(channel: ActiveChannel): Promise<void> {
    channel.ready = false
    if (channel.agreement !== undefined) clearTimeout(channel.agreement.timer)
    const ephemeral = generateX25519Key()
    const nonce = encodeBase64Url(randomBytes(32))
    const timer = setTimeout(() => { void this.close(channel.binding.bindingRef) }, 30_000)
    timer.unref()
    channel.agreement = {
      hostPrivateJwk: ephemeral.privateJwk, hostEphemeralPublicKey: ephemeral.publicKey,
      nonce, nextEpoch: channel.keyEpoch + 1, timer,
    }
    const unsigned = {
      protocol: 'dsh.remote-key' as const, protocol_major: 1 as const, kind: 'host-key-init' as const,
      direction: 'host-to-controller' as const,
      binding_ref: channel.binding.bindingRef, binding_revision: channel.binding.revision,
      runtime_ref: this.options.runtimeRef, channel_ref: channel.claims.channel_ref,
      host_authorization_ref: channel.authorizationRef, host_remote_auth_epoch: channel.remoteAuthEpoch,
      host_ephemeral_public_key: ephemeral.publicKey, host_key_fingerprint: this.options.identity.keyFingerprint,
      nonce, next_key_epoch: channel.keyEpoch + 1, issued_at: this.now(),
    }
    const init: HostKeyInit = { ...unsigned, signature: signEd25519(this.options.identity.privateJwk, canonicalJson(unsigned)) }
    await this.options.realtime.publish({
      channelRef: channel.claims.channel_ref, authorizationRef: channel.authorizationRef,
      commandId: `keyinit_${randomUUID()}`, direction: 'response', payload: rawPayload(init), signal: channel.controller.signal,
    })
  }

  private async confirmKeyAgreement(
    channel: ActiveChannel,
    payload: Record<string, unknown>,
    metadata: DshRemoteTrustedEventMetadata,
  ): Promise<void> {
    const agreement = channel.agreement
    if (agreement === undefined || payload.protocol !== 'dsh.remote-key' || payload.kind !== 'controller-key-confirm') return
    const controllerEphemeralPublicKey = typeof payload.controller_ephemeral_public_key === 'string' ? payload.controller_ephemeral_public_key : ''
    const signature = typeof payload.signature === 'string' ? payload.signature : ''
    const suppliedConfirmation = typeof payload.confirmation === 'string' ? payload.confirmation : ''
    const unsigned = { ...payload }
    delete unsigned.signature
    if (payload.binding_ref !== channel.binding.bindingRef || payload.binding_revision !== channel.binding.revision
      || payload.runtime_ref !== this.options.runtimeRef || payload.channel_ref !== channel.claims.channel_ref
      || payload.host_authorization_ref !== channel.authorizationRef || payload.host_remote_auth_epoch !== channel.remoteAuthEpoch
      || payload.controller_authorization_ref !== metadata.authorizationRef || payload.controller_remote_auth_epoch !== metadata.remoteAuthEpoch
      || payload.host_ephemeral_public_key !== agreement.hostEphemeralPublicKey || payload.nonce !== agreement.nonce
      || payload.next_key_epoch !== agreement.nextEpoch || payload.controller_key_fingerprint !== channel.controllerKeyFingerprint
      || !/^[A-Za-z0-9_-]{43}$/.test(controllerEphemeralPublicKey)
      || !verifyEd25519(channel.controllerPublicKey, canonicalJson(unsigned), signature)) return
    const transcript = agreementTranscript({
      bindingRef: channel.binding.bindingRef, bindingRevision: channel.binding.revision,
      runtimeRef: this.options.runtimeRef, channelRef: channel.claims.channel_ref,
      hostAuthorizationRef: channel.authorizationRef, hostRemoteAuthEpoch: channel.remoteAuthEpoch,
      controllerAuthorizationRef: metadata.authorizationRef, controllerRemoteAuthEpoch: metadata.remoteAuthEpoch,
      hostEphemeralPublicKey: agreement.hostEphemeralPublicKey, controllerEphemeralPublicKey, nonce: agreement.nonce,
    })
    const shared = deriveX25519(agreement.hostPrivateJwk, controllerEphemeralPublicKey)
    const keys = deriveDirectionalKeys(shared, channel.rootSecret, transcript)
    if (pairingKeyConfirmation(keys.confirmation, transcript, 'controller') !== suppliedConfirmation) {
      await this.close(channel.binding.bindingRef)
      return
    }
    clearTimeout(agreement.timer)
    channel.keyEpoch = agreement.nextEpoch
    channel.controllerToHost = keys.controllerToHost
    channel.hostToController = keys.hostToController
    delete channel.agreement
    await this.options.credentialBroker.putChannelKeys({
      accountId: this.options.accountId, bindingRef: channel.binding.bindingRef,
      runtimeRef: this.options.runtimeRef, channelRef: channel.claims.channel_ref,
      keyEpoch: channel.keyEpoch, rootSecret: channel.rootSecret,
      controllerPublicKey: channel.controllerPublicKey, controllerKeyFingerprint: channel.controllerKeyFingerprint,
      controllerToHost: channel.controllerToHost, hostToController: channel.hostToController,
    })
    const hostConfirmation = {
      protocol: 'dsh.remote-key', protocol_major: 1, kind: 'host-key-confirm', direction: 'host-to-controller',
      binding_ref: channel.binding.bindingRef, runtime_ref: this.options.runtimeRef, channel_ref: channel.claims.channel_ref,
      key_epoch: channel.keyEpoch, confirmation: pairingKeyConfirmation(keys.confirmation, transcript, 'host'), issued_at: this.now(),
    }
    await this.options.realtime.publish({
      channelRef: channel.claims.channel_ref, authorizationRef: channel.authorizationRef,
      commandId: `keyconfirm_${randomUUID()}`, direction: 'response', payload: rawPayload({
        ...hostConfirmation, signature: signEd25519(this.options.identity.privateJwk, canonicalJson(hostConfirmation)),
      }), signal: channel.controller.signal,
    })
    channel.ready = true
    channel.rotateTimer = setTimeout(() => { void this.startKeyAgreement(channel) }, 30 * 60_000)
    channel.rotateTimer.unref()
  }

  private scheduleRenew(channel: ActiveChannel): void {
    const lifetimeMillis = Math.max(1_000, (channel.claims.exp - channel.claims.iat) * 1000)
    channel.renewTimer = setTimeout(() => {
      if (this.channels.get(channel.binding.bindingRef) === channel) {
        void this.open(channel.binding).catch(() => { void this.close(channel.binding.bindingRef) })
      }
    }, Math.max(1_000, Math.floor(lifetimeMillis * 0.6)))
    channel.renewTimer.unref()
  }
}

export const dshRemoteControlAgreementTranscript = agreementTranscript
