import { randomBytes, randomUUID } from 'node:crypto'
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto'
import { canonicalJson, encodeBase64Url, generatePairingCode, generateX25519Key, pairingLocator, signEd25519 } from './crypto.js'
import { DshRemoteError } from './errors.js'
import {
  DSH_REMOTE_PAIRING_TTL_MS,
  type DshRemoteControlPlane,
  type DshRemoteDeviceKeyMaterial,
  type DshRemoteIssuedGrant,
  type DshRemotePairingQrPayload,
  type DshRemotePairingTicket,
} from './types.js'

interface PairingAttemptState {
  ticket: DshRemotePairingTicket
  privateJwk: NodeJsonWebKey
  challenge: string
  manualCode: string
  grant: DshRemoteIssuedGrant
  ready: boolean
}

export interface DshRemotePreparedPairingAttempt {
  ticket: DshRemotePairingTicket
  grant: DshRemoteIssuedGrant
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof source[key] === 'string' && source[key] !== '') return source[key] as string
  throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', `配对响应缺少 ${keys[0] ?? 'field'}`, true)
}

function integerField(source: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) if (typeof source[key] === 'number' && Number.isSafeInteger(source[key]) && Number(source[key]) > 0) return Number(source[key])
  return fallback
}

function displayCode(code: string): string { return code.match(/.{1,4}/g)?.join('-') ?? code }

export class DshRemotePairingCoordinator {
  private current: PairingAttemptState | undefined

  constructor(
    private readonly controlPlane: DshRemoteControlPlane,
    private readonly environment: 'test' | 'production',
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: {
    desktopRef: string
    runtimeRef: string
    identity: DshRemoteDeviceKeyMaterial
    userId: number
    clientId: number
    signal?: AbortSignal
  }): Promise<DshRemotePreparedPairingAttempt> {
    if (this.current !== undefined) this.clear(this.current.ticket.pairingRef)
    const code = generatePairingCode()
    const ephemeral = generateX25519Key()
    const hostEphemeralPublicKey = ephemeral.publicKey
    if (hostEphemeralPublicKey === '') throw new DshRemoteError('REMOTE_STORAGE_FAILED', '无法生成配对临时公钥')
    const pairingChannelRef = `pairing_${randomUUID()}`
    const challenge = encodeBase64Url(randomBytes(32))
    const locator = pairingLocator(code)
    const nonce = encodeBase64Url(randomBytes(32))
    const proof = signEd25519(input.identity.privateJwk, [
      'dsh-remote.pairing.issue.v1', String(input.userId), String(input.clientId), input.desktopRef,
      input.runtimeRef, pairingChannelRef, challenge, hostEphemeralPublicKey, locator, nonce,
    ].join('\n'))
    const created = await this.controlPlane.createPairingAttempt(input.desktopRef, {
      runtime_ref: input.runtimeRef,
      pairing_channel_ref: pairingChannelRef,
      code_locator: locator,
      challenge,
      host_ephemeral_key: hostEphemeralPublicKey,
      proof_nonce: nonce,
      proof_signature: proof,
    }, input.signal)
    const pairingRef = stringField(created.pairing, 'pairing_ref', 'pairingRef')
    if (stringField(created.pairing, 'pairing_channel_ref', 'pairingChannelRef') !== pairingChannelRef
      || stringField(created.pairing, 'challenge') !== challenge) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Backend 返回的配对挑战与 Host 签名请求不一致')
    }
    const expiresAtMillis = integerField(created.pairing, this.now() + DSH_REMOTE_PAIRING_TTL_MS, 'expires_at', 'expiresAtMillis')
    const unsigned: Omit<DshRemotePairingQrPayload, 'host_signature'> = {
      scheme: 'jotmo-dsh-remote', version: 1, environment: this.environment,
      pairing_ref: pairingRef, challenge, expires_at: expiresAtMillis,
      host_fingerprint: input.identity.keyFingerprint, host_public_signing_key: input.identity.publicKey,
      host_ephemeral_public_key: hostEphemeralPublicKey,
    }
    const qr: DshRemotePairingQrPayload = { ...unsigned, host_signature: signEd25519(input.identity.privateJwk, canonicalJson(unsigned)) }
    const ticket: DshRemotePairingTicket = {
      pairingRef, pairingChannelRef, qrPayload: canonicalJson(qr), pairingCode: displayCode(code),
      hostKeyFingerprint: input.identity.keyFingerprint, expiresAtMillis, runtimeRef: input.runtimeRef,
    }
    this.current = { ticket, privateJwk: ephemeral.privateJwk, challenge, manualCode: code, grant: created.grant, ready: false }
    return { ticket: { ...ticket }, grant: { ...created.grant } }
  }

  currentTicket(): DshRemotePairingTicket | undefined {
    if (this.current === undefined || !this.current.ready || this.current.ticket.expiresAtMillis <= this.now()) return undefined
    return { ...this.current.ticket }
  }

  activate(pairingRef: string): DshRemotePairingTicket {
    const current = this.require(pairingRef)
    current.ready = true
    return { ...current.ticket }
  }

  secret(pairingRef: string): {
    privateJwk: NodeJsonWebKey
    challenge: string
    manualCode: string
    pairingChannelRef: string
    grant: DshRemoteIssuedGrant
  } {
    const current = this.require(pairingRef)
    return {
      privateJwk: current.privateJwk,
      challenge: current.challenge,
      manualCode: current.manualCode,
      pairingChannelRef: current.ticket.pairingChannelRef,
      grant: { ...current.grant },
    }
  }

  private require(pairingRef: string): PairingAttemptState {
    const current = this.current
    if (current === undefined || current.ticket.pairingRef !== pairingRef || current.ticket.expiresAtMillis <= this.now()) {
      throw new DshRemoteError('PAIRING_EXPIRED', '配对尝试已过期')
    }
    return current
  }

  async cancel(pairingRef: string, _identity: DshRemoteDeviceKeyMaterial, _signal?: AbortSignal): Promise<void> {
    const current = this.current
    if (current === undefined || current.ticket.pairingRef !== pairingRef) return
    // v4 Backend deliberately has no cancel endpoint. Dropping the local secret
    // makes this Host unable to confirm; the server attempt expires within 10m.
    this.current = undefined
  }

  clear(pairingRef: string): void {
    if (this.current?.ticket.pairingRef === pairingRef) this.current = undefined
  }
}
