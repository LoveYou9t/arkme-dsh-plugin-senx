import { DshRemoteError, type DshRemoteErrorCode } from './errors.js'
import type {
  DshRemoteBindingProjection,
  DshRemoteConfirmedPairing,
  DshRemoteControlPlane,
  DshRemoteCreatedPairingAttempt,
  DshRemoteIssuedGrant,
} from './types.js'

const BASE = '/api/v1/dsh-remote'

export interface DshRemoteHttpRequester {
  get(path: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', `Backend ${label} 合同无效`, true)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', `Backend ${label} 合同无效`, true)
  return value
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function pathRef(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(normalized)) throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控资源引用无效')
  return encodeURIComponent(normalized)
}

export class DshRemoteHttpControlPlane implements DshRemoteControlPlane {
  constructor(private readonly request: DshRemoteHttpRequester) {}

  private async get(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try { return await this.request.get(path, signal) }
    catch (error) { throw mapDshRemoteControlPlaneError(error) }
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try { return await this.request.post(path, body, signal) }
    catch (error) { throw mapDshRemoteControlPlaneError(error) }
  }

  async registerDeviceCredential(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.post(`${BASE}/device-credentials/register`, input, signal)
  }

  async registerDesktop(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.post(`${BASE}/desktops/register`, input, signal)
  }

  async registerRuntime(desktopRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.post(`${BASE}/desktops/${pathRef(desktopRef)}/runtimes/register`, input, signal)
  }

  async updateRuntimePolicy(desktopRef: string, runtimeRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.post(`${BASE}/desktops/${pathRef(desktopRef)}/runtimes/${pathRef(runtimeRef)}/policy`, input, signal)
  }

  async createPairingAttempt(desktopRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteCreatedPairingAttempt> {
    const value = await this.post(`${BASE}/desktops/${pathRef(desktopRef)}/pairing-attempts`, input, signal)
    return { pairing: record(value.pairing, 'pairing'), grant: issuedGrant(value.grant) }
  }

  async confirmPairing(pairingRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteConfirmedPairing> {
    const value = await this.post(`${BASE}/pairing-attempts/${pathRef(pairingRef)}/host-confirm`, input, signal)
    return {
      pairing: record(value.pairing, 'pairing'),
      binding: bindingProjection(record(value.binding, 'binding')),
      grant: issuedGrant(value.grant),
    }
  }

  async listBindings(signal?: AbortSignal): Promise<DshRemoteBindingProjection[]> {
    const value = await this.get(`${BASE}/bindings`, signal)
    if (!Array.isArray(value.bindings)) throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Backend bindings 合同无效', true)
    return value.bindings.map(item => {
      const envelope = record(item, 'binding envelope')
      const binding = record(envelope.binding, 'binding')
      record(envelope.desktop, 'desktop')
      const controller = record(envelope.controller, 'controller')
      return {
        ...bindingProjection(binding),
        controllerDisplayName: string(controller.device_name, 'controller.device_name'),
        controllerPlatform: string(controller.platform, 'controller.platform'),
      }
    })
  }

  async revokeBinding(bindingRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.post(`${BASE}/bindings/${pathRef(bindingRef)}/revoke`, input, signal)
  }

  async requestChannelGrant(input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteIssuedGrant> {
    const value = await this.post(`${BASE}/channel-grants`, input, signal)
    return issuedGrant(value)
  }
}

function issuedGrant(value: unknown): DshRemoteIssuedGrant {
  const source = record(value, 'grant')
  return {
    grant: string(source.token, 'grant token'),
    ...(typeof source.grant_ref === 'string' ? { grantRef: source.grant_ref } : {}),
    ...(typeof source.channel_ref === 'string' ? { channelRef: source.channel_ref } : {}),
    ...(integer(source.expires_at) <= 0 ? {} : { expiresAtMillis: integer(source.expires_at) }),
  }
}

function bindingProjection(binding: Record<string, unknown>): DshRemoteBindingProjection {
  const status = binding.status === 'active' || binding.status === 'suspended' || binding.status === 'revoked' ? binding.status : 'revoked'
  return {
    bindingRef: string(binding.binding_ref, 'binding_ref'),
    controllerCredentialRef: string(binding.controller_credential_ref, 'controller_credential_ref'),
    controllerDisplayName: '已配对移动设备', controllerPlatform: 'unknown',
    revision: integer(binding.binding_revision, 1), status,
    scopes: Array.isArray(binding.scopes) ? binding.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    boundAtMillis: integer(binding.created_at),
    ...(integer(binding.last_used_at) <= 0 ? {} : { lastUsedAtMillis: integer(binding.last_used_at) }),
  }
}

export function mapDshRemoteControlPlaneError(error: unknown): DshRemoteError {
  if (error instanceof DshRemoteError) return error
  const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : ''
  const canonical = new Set<DshRemoteErrorCode>([
    'REMOTE_PROTOCOL_UNSUPPORTED', 'REMOTE_REQUEST_INVALID', 'REMOTE_INVALID_RESPONSE',
    'REMOTE_NETWORK_UNAVAILABLE', 'REMOTE_STORAGE_FAILED', 'REMOTE_TRANSPORT_FAILED',
    'PAIRING_EXPIRED', 'PAIRING_ALREADY_CLAIMED', 'PAIRING_ACCOUNT_MISMATCH',
    'PAIRING_CHANNEL_CONFLICT', 'PAIRING_LOCATOR_CONFLICT', 'PAIRING_KEY_CONFIRM_FAILED',
    'DEVICE_CREDENTIAL_REVOKED', 'DEVICE_PROOF_INVALID', 'RUNTIME_OFFLINE', 'RUNTIME_LIMIT_REACHED',
    'REMOTE_DISABLED', 'BINDING_REVOKED', 'REVOCATION_PROPAGATING', 'CHANNEL_GRANT_EXPIRED',
    'HOST_CHANNEL_NOT_READY', 'CAPABILITY_UNSUPPORTED', 'PAIRING_RATE_LIMITED',
  ])
  return new DshRemoteError(
    canonical.has(code as DshRemoteErrorCode) ? code as DshRemoteErrorCode : 'REMOTE_TRANSPORT_FAILED',
    error instanceof Error ? error.message : '远控控制面请求失败',
    ['REMOTE_NETWORK_UNAVAILABLE', 'REMOTE_TRANSPORT_FAILED', 'RUNTIME_OFFLINE', 'REVOCATION_PROPAGATING',
      'CHANNEL_GRANT_EXPIRED', 'HOST_CHANNEL_NOT_READY', 'PAIRING_RATE_LIMITED'].includes(code),
    {}, { cause: error },
  )
}
