import { hostname } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DshApiProxyAdapter } from './api-proxy-adapter.js'
import { DshRemoteCommandLedger, type DshRemoteLedgerEntry } from './command-ledger.js'
import { DshRemoteHostChannelManager } from './channel-manager.js'
import { DesktopCredentialBroker } from './desktop-credential-broker.js'
import {
  canonicalJson,
  decodeBase64Url,
  deriveDirectionalKeys,
  deriveX25519,
  encodeBase64Url,
  pairingKeyConfirmation,
  pairingPsk,
  pairingTranscript,
  sha256,
  signEd25519,
  verifyEd25519,
  verifyPairingKeyConfirmation,
  verifyRemoteGrant,
} from './crypto.js'
import { asDshRemoteError, DshRemoteError } from './errors.js'
import { DshRemotePairingCoordinator } from './pairing.js'
import { parseDshRemoteRequest } from './protocol-v1.js'
import { DshRemoteRuntimeStore } from './runtime-store.js'
import {
  DSH_REMOTE_PROTOCOL,
  DSH_REMOTE_PROTOCOL_MAJOR,
  type DshRemoteBindingProjection,
  type DshRemoteControlPlane,
  type DshRemoteDeviceKeyMaterial,
  type DshRemoteHostFacade,
  type DshRemoteGrantClaims,
  type DshRemoteIssuedGrant,
  type DshRemoteOperation,
  type DshRemotePairingTicket,
  type DshRemoteRealtimeTransport,
  type DshRemoteRealtimePayload,
  type DshRemoteRequest,
  type DshRemoteResponse,
  type DshRemoteRuntimeProjection,
  type DshRemoteStatus,
  type DshRemoteTrustedEventMetadata,
} from './types.js'

interface HostSession { userId: number; clientId: number }
interface HostRuntimeContext {
  bindingRef: string
  serviceLeaseGeneration: number
  metadata: DshRemoteTrustedEventMetadata
}

interface HostPairingChannel {
  pairingRef: string
  claims: DshRemoteGrantClaims
  authorizationRef: string
  controller: AbortController
  unsubscribe: () => void
  renewTimer?: ReturnType<typeof setTimeout>
  handling: boolean
}

export interface ArkmeRemoteRealtimeHostOptions {
  featureEnabled: boolean
  transportAvailable?: boolean
  environment: 'test' | 'production'
  profileRef: string
  hostClientRef: string
  displayName?: string
  platform?: NodeJS.Platform
  readSession: () => Promise<HostSession | undefined>
  credentialBroker: DesktopCredentialBroker
  runtimeStore: DshRemoteRuntimeStore
  controlPlane: DshRemoteControlPlane
  realtime: DshRemoteRealtimeTransport
  apiProxy: DshApiProxyAdapter
  ledgerForAccount: (accountId: string, key: Buffer) => Promise<DshRemoteCommandLedger> | DshRemoteCommandLedger
  grantSigningKeys: Readonly<Record<string, string>>
  now?: () => number
}

function stringBody(body: Record<string, unknown>, key: string, max = 256): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new DshRemoteError('REMOTE_REQUEST_INVALID', `${key} 无效`)
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  return typeof body[key] === 'string' && body[key] !== '' ? body[key] as string : undefined
}

function optionalPositive(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function operationScopes(operation: DshRemoteOperation): string[] {
  switch (operation) {
    case 'capabilities.get': return []
    case 'snapshot.get': return ['workspace.read', 'session.read']
    case 'workspace.list': return ['workspace.read']
    case 'session.list':
    case 'session.history': return ['session.read']
    case 'session.create': return ['session.create']
    case 'session.prompt': return ['session.prompt']
    case 'session.cancel': return ['session.cancel']
    case 'interaction.question.respond': return ['interaction.question.answer']
    case 'interaction.approval.respond': return ['interaction.approval.respond']
  }
}

function response(
  request: DshRemoteRequest,
  status: DshRemoteResponse['status'],
  now: number,
  payload: { result?: unknown; error?: NonNullable<DshRemoteResponse['error']> },
): DshRemoteResponse {
  const result: DshRemoteResponse = {
    protocol: DSH_REMOTE_PROTOCOL, protocol_major: DSH_REMOTE_PROTOCOL_MAJOR, kind: 'response',
    request_ref: request.request_ref, status, host_generation: request.host_generation,
    issued_at: now, operation: request.operation, body: {},
  }
  if (payload.result !== undefined) result.result = payload.result
  if (payload.error !== undefined) result.error = payload.error
  return result
}

function resultFromLedger(entry: DshRemoteLedgerEntry): unknown {
  const result = entry.payload.result
  if (result !== null && typeof result === 'object' && 'rejected' in result) {
    const rejected = (result as { rejected?: unknown }).rejected
    if (rejected !== null && typeof rejected === 'object') {
      const source = rejected as Record<string, unknown>
      throw new DshRemoteError(
        typeof source.code === 'string' ? source.code as ConstructorParameters<typeof DshRemoteError>[0] : 'REMOTE_TRANSPORT_FAILED',
        typeof source.message === 'string' ? source.message : 'DSH 已拒绝该远控命令',
        source.retryable === true,
      )
    }
  }
  return result !== null && typeof result === 'object' && 'value' in result ? (result as { value: unknown }).value : result
}

/**
 * Host-only facade. It owns lifecycle, local policy, durable idempotency and the
 * narrow DSH projection; neither the SDK nor mobile clients receive ApiProxy.
 */
export class ArkmeRemoteRealtimeHost implements DshRemoteHostFacade {
  private readonly now: () => number
  private readonly pairing: DshRemotePairingCoordinator
  private readonly listeners = new Set<(status: DshRemoteStatus) => void>()
  private runtime: DshRemoteRuntimeProjection | undefined
  private identity: DshRemoteDeviceKeyMaterial | undefined
  private accountId: string | undefined
  private userId = 0
  private clientId = 0
  private credentialRef: string | undefined
  private backendRuntimeRevision = 0
  private ledger: DshRemoteCommandLedger | undefined
  private started = false
  private connected = false
  private serviceLeaseGeneration = 0
  private bindings: DshRemoteBindingProjection[] = []
  private revision = 0
  private stopEvents: (() => void) | undefined
  private channelManager: DshRemoteHostChannelManager | undefined
  private pairingChannel: HostPairingChannel | undefined
  private stopTransportDisconnect: (() => void) | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnecting = false
  private sessionTimer: ReturnType<typeof setTimeout> | undefined
  private connectionError: DshRemoteError | undefined

  constructor(private readonly options: ArkmeRemoteRealtimeHostOptions) {
    this.now = options.now ?? Date.now
    this.pairing = new DshRemotePairingCoordinator(options.controlPlane, options.environment, this.now)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (!this.options.featureEnabled) { this.bump(); return }
    this.stopTransportDisconnect = this.options.realtime.subscribeDisconnect(() => { this.handleTransportDisconnect() })
    await this.syncSessionSafely()
    this.scheduleSessionSync()
  }

  private async syncSessionSafely(): Promise<void> {
    try {
      await this.syncSession()
    } catch (error) {
      this.connectionError = asDshRemoteError(error)
      this.bump()
    }
  }

  private async syncSession(): Promise<void> {
    if (!this.started || !this.options.featureEnabled) return
    const session = await this.options.readSession()
    if (session === undefined) {
      if (this.accountId !== undefined) await this.deactivateAccount()
      this.bump()
      return
    }
    const accountId = String(session.userId)
    if (this.accountId === accountId && this.clientId === session.clientId && this.runtime !== undefined) return
    if (this.accountId !== undefined) await this.deactivateAccount()
    this.userId = session.userId
    this.clientId = session.clientId
    this.accountId = accountId
    this.identity = await this.options.credentialBroker.getOrCreate(accountId)
    this.runtime = await this.options.runtimeStore.activateRuntime({
      accountId, profileRef: this.options.profileRef, capabilities: this.options.apiProxy.capabilities(), nowMillis: this.now(),
    })
    this.ledger = await this.options.ledgerForAccount(accountId, await this.options.credentialBroker.ledgerKey(accountId))
    await this.reconcileUnsettled()
    const state = await this.options.runtimeStore.account(accountId)
    this.bindings = state.bindings
    if (this.runtime.remoteEnabled && this.options.transportAvailable !== false) {
      this.startApiProxyEvents()
      await this.connectHost().catch(error => { this.handleTransportDisconnect(error) })
    } else {
      this.connectionError = undefined
    }
    this.bump()
  }

  private scheduleSessionSync(): void {
    if (!this.started || !this.options.featureEnabled || this.sessionTimer !== undefined) return
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined
      void this.syncSessionSafely().finally(() => { this.scheduleSessionSync() })
    }, 2_000)
    this.sessionTimer.unref()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.stopApiProxyEvents()
    this.stopTransportDisconnect?.()
    this.stopTransportDisconnect = undefined
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer)
    this.sessionTimer = undefined
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    await this.deactivateAccount()
    this.bump()
  }

  private async deactivateAccount(): Promise<void> {
    this.stopApiProxyEvents()
    try { if (this.connected) await this.options.realtime.unregisterHost() } catch { /* Lease expiry remains the fallback. */ }
    await this.channelManager?.closeAll()
    this.channelManager = undefined
    this.closePairingChannel()
    await this.options.realtime.disconnect()
    this.connected = false
    this.serviceLeaseGeneration = 0
    this.ledger?.close()
    this.ledger = undefined
    this.runtime = undefined
    this.identity = undefined
    this.accountId = undefined
    this.userId = 0
    this.clientId = 0
    this.credentialRef = undefined
    this.backendRuntimeRevision = 0
    this.bindings = []
    this.connectionError = undefined
  }

  private startApiProxyEvents(): void {
    if (this.stopEvents === undefined) this.stopEvents = this.options.apiProxy.startEvents()
  }

  private stopApiProxyEvents(): void {
    this.stopEvents?.()
    this.stopEvents = undefined
  }

  private handleTransportDisconnect(error?: unknown): void {
    if (!this.started || this.runtime?.remoteEnabled !== true) return
    const remote = error === undefined ? undefined : asDshRemoteError(error)
    if (remote !== undefined) this.connectionError = remote
    this.connected = false
    this.serviceLeaseGeneration = 0
    this.closePairingChannel()
    void this.channelManager?.closeAll()
    this.channelManager = undefined
    this.bump()
    if (this.reconnectTimer !== undefined || this.options.transportAvailable === false || remote?.retryable === false) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.started || this.runtime?.remoteEnabled !== true || this.reconnecting) return
      this.reconnecting = true
      void this.connectHost().catch(caught => { this.handleTransportDisconnect(caught) }).finally(() => { this.reconnecting = false })
    }, 1_000)
    this.reconnectTimer.unref()
  }

  getStatus(): DshRemoteStatus {
    const available = this.options.featureEnabled && this.accountId !== undefined && this.options.transportAvailable !== false
      && this.options.apiProxy.capabilities().length > 0
      && Object.keys(this.options.grantSigningKeys).length > 0
    return {
      contractVersion: 1, available, enabled: this.runtime?.remoteEnabled === true,
      connected: this.connected, hostGeneration: this.runtime?.hostGeneration ?? 0,
      capabilities: this.runtime?.capabilities ?? this.options.apiProxy.capabilities(),
      bindings: this.bindings.map(item => ({ ...item })), revision: this.revision,
      ...(this.accountId === undefined ? {} : { accountId: this.accountId }),
      ...(this.runtime?.desktopRef === undefined ? {} : { desktopRef: this.runtime.desktopRef }),
      ...(this.runtime === undefined ? {} : { runtimeRef: this.runtime.runtimeRef }),
      ...(this.pairing.currentTicket() === undefined ? {} : { pairingAttempt: this.pairing.currentTicket()! }),
      ...(this.connectionError !== undefined ? { unavailableReason: this.connectionError.message }
        : available ? {} : { unavailableReason: !this.options.featureEnabled
        ? '远控能力尚未在此版本启用'
        : this.accountId === undefined
          ? '请先登录 Arkme 后再配置远控'
        : this.options.transportAvailable === false
          ? '当前 DSH Host 尚未提供带登录态的 Realtime Socket Factory'
        : this.options.apiProxy.capabilities().length === 0
          ? '当前 DSH 缺少公共 ApiProxy 能力'
          : '远控 Grant 验签密钥尚未配置' }),
    }
  }

  async setEnabled(enabled: boolean): Promise<DshRemoteStatus> {
    this.requireReady()
    if (!this.options.featureEnabled) throw new DshRemoteError('CAPABILITY_UNSUPPORTED', '远控功能开关尚未开放')
    if (enabled && !this.getStatus().available) {
      throw new DshRemoteError('CAPABILITY_UNSUPPORTED', this.getStatus().unavailableReason ?? '远控运行依赖尚未就绪')
    }
    if (enabled && this.options.transportAvailable === false) {
      throw new DshRemoteError('CAPABILITY_UNSUPPORTED', '当前 DSH Host 缺少安全的 Realtime 连接能力')
    }
    const accountId = this.accountId!
    if (!enabled) {
      try { if (this.connected) await this.options.realtime.unregisterHost() } finally {
        this.stopApiProxyEvents()
        await this.channelManager?.closeAll()
        this.channelManager = undefined
        await this.options.realtime.disconnect()
        this.connected = false
        this.connectionError = undefined
        this.serviceLeaseGeneration = 0
        this.runtime = await this.options.runtimeStore.setRemoteEnabled(accountId, this.options.profileRef, false)
        this.bump()
      }
      if (this.runtime.desktopRef !== undefined) {
        await this.options.controlPlane.updateRuntimePolicy(this.runtime.desktopRef, this.runtime.runtimeRef, this.signedPolicy(false))
      }
      return this.getStatus()
    }
    this.runtime = await this.options.runtimeStore.setRemoteEnabled(accountId, this.options.profileRef, true)
    this.startApiProxyEvents()
    try { await this.connectHost() }
    catch (error) { this.handleTransportDisconnect(error); throw error }
    this.bump()
    return this.getStatus()
  }

  async createPairingAttempt(): Promise<DshRemotePairingTicket> {
    this.requireConnected()
    const runtime = this.runtime!
    const identity = this.identity!
    if (runtime.desktopRef === undefined) throw new DshRemoteError('REMOTE_STORAGE_FAILED', '桌面设备尚未注册')
    this.closePairingChannel()
    const prepared = await this.pairing.create({
      desktopRef: runtime.desktopRef, runtimeRef: runtime.runtimeRef, identity,
      userId: this.userId, clientId: this.clientId,
    })
    try {
      await this.openPairingChannel(prepared.ticket.pairingRef, prepared.grant)
      const ticket = this.pairing.activate(prepared.ticket.pairingRef)
      this.bump()
      return ticket
    } catch (error) {
      this.pairing.clear(prepared.ticket.pairingRef)
      this.closePairingChannel()
      throw error
    }
  }

  async cancelPairingAttempt(pairingRef: string): Promise<void> {
    this.requireReady()
    if (this.pairingChannel?.pairingRef === pairingRef) this.closePairingChannel()
    await this.pairing.cancel(pairingRef, this.identity!)
    this.bump()
  }

  async listBindings(): Promise<DshRemoteBindingProjection[]> {
    this.requireReady()
    const items = await this.options.controlPlane.listBindings()
    this.bindings = items
    await this.options.runtimeStore.upsertBindings(this.accountId!, items)
    this.bump()
    if (this.channelManager !== undefined) {
      for (const binding of items) {
        if (binding.status === 'active') await this.channelManager.open(binding).catch(() => undefined)
      }
    }
    return items.map(item => ({ ...item }))
  }

  async revokeBinding(bindingRef: string): Promise<void> {
    this.requireReady()
    const normalized = bindingRef.trim()
    await this.options.controlPlane.revokeBinding(normalized, {
      actor_credential_ref: this.credentialRef,
    })
    this.bindings = this.bindings.map(item => item.bindingRef === normalized ? { ...item, status: 'revoked' } : item)
    await this.channelManager?.close(normalized)
    await this.options.runtimeStore.upsertBindings(this.accountId!, this.bindings)
    this.bump()
  }

  async renameDesktop(displayName: string): Promise<DshRemoteStatus> {
    this.requireReady()
    await this.options.runtimeStore.renameDesktop(this.accountId!, displayName)
    if (this.runtime?.desktopRef !== undefined) {
      const nonce = encodeBase64Url(randomBytes(32))
      const credentialRef = this.credentialRef!
      const platform = this.options.platform ?? process.platform
      await this.options.controlPlane.registerDesktop({
        credential_ref: credentialRef, display_name: displayName.trim(), platform,
        proof_nonce: nonce,
        proof_signature: signEd25519(this.identity!.privateJwk, [
          'dsh-remote.desktop.register.v1', String(this.userId), String(this.clientId), credentialRef,
          displayName.trim(), platform, nonce,
        ].join('\n')),
      })
    }
    this.bump()
    return this.getStatus()
  }

  subscribe(listener: (status: DshRemoteStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => { this.listeners.delete(listener) }
  }

  /** Entry used only by the authenticated/decrypted Realtime channel bridge. */
  async dispatchAuthorizedRequest(value: unknown, context: HostRuntimeContext): Promise<DshRemoteResponse> {
    this.requireConnected()
    if (context.metadata.senderRole !== 'controller' || context.metadata.authorizationRef === '' || context.metadata.senderCredentialRef === '') {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', '远控发送方上下文无效')
    }
    if (context.serviceLeaseGeneration !== this.serviceLeaseGeneration
      || context.metadata.targetHostLeaseGeneration !== this.serviceLeaseGeneration) {
      throw new DshRemoteError('HOST_GENERATION_STALE', '远控请求属于旧 Host lease', true)
    }
    if (this.now() - context.metadata.acceptedAtMillis > 30_000) throw new DshRemoteError('COMMAND_EXPIRED', '远控请求投递延迟过长')
    const request = parseDshRemoteRequest(value, { expectedHostGeneration: this.runtime!.hostGeneration, nowMillis: this.now() })
    try {
      const binding = this.bindings.find(item => item.bindingRef === context.bindingRef && item.status === 'active')
      if (binding === undefined) throw new DshRemoteError('BINDING_REVOKED', '远控绑定已失效')
      if (operationScopes(request.operation).some(scope => !binding.scopes.includes(scope))) {
        throw new DshRemoteError('CAPABILITY_UNSUPPORTED', '当前远控绑定未授权该操作')
      }
      const result = await this.dispatch(request, context.bindingRef)
      return response(request, result.duplicate ? 'duplicate' : 'completed', this.now(), { result: result.value as unknown })
    } catch (error) {
      const remote = asDshRemoteError(error)
      return response(request, 'rejected', this.now(), {
        error: { code: remote.code, message: remote.message.slice(0, 256), retryable: remote.retryable, trace_ref: randomUUID() },
      })
    }
  }

  private async connectHost(): Promise<void> {
    const runtime = this.runtime!
    const identity = this.identity!
    const accountId = this.accountId!
    const platform = this.options.platform ?? process.platform
    const credentialNonce = encodeBase64Url(randomBytes(32))
    const credential = await this.options.controlPlane.registerDeviceCredential({
      role: 'desktop', public_signing_key: identity.publicKey, key_epoch: identity.keyEpoch,
      device_name: this.options.displayName ?? hostname(), platform, proof_nonce: credentialNonce,
      proof_signature: signEd25519(identity.privateJwk, [
        'dsh-remote.device-credential.register.v1', String(this.userId), String(this.clientId), 'desktop',
        String(identity.keyEpoch), identity.publicKey, credentialNonce,
      ].join('\n')),
    })
    const credentialRef = typeof credential.credential_ref === 'string' ? credential.credential_ref : ''
    if (credentialRef === '') throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Backend 未返回桌面凭据引用', true)
    this.credentialRef = credentialRef
    const displayName = (await this.options.runtimeStore.account(accountId)).displayName ?? this.options.displayName ?? hostname()
    const desktopNonce = encodeBase64Url(randomBytes(32))
    const desktop = await this.options.controlPlane.registerDesktop({
      credential_ref: credentialRef, display_name: displayName, platform, proof_nonce: desktopNonce,
      proof_signature: signEd25519(identity.privateJwk, [
        'dsh-remote.desktop.register.v1', String(this.userId), String(this.clientId), credentialRef,
        displayName, platform, desktopNonce,
      ].join('\n')),
    })
    const desktopRef = typeof desktop.desktop_ref === 'string' ? desktop.desktop_ref : typeof desktop.desktopRef === 'string' ? desktop.desktopRef : ''
    const desktopCredentialRef = typeof desktop.credential_ref === 'string' ? desktop.credential_ref : typeof desktop.credentialRef === 'string' ? desktop.credentialRef : ''
    if (desktopRef === '' || desktopCredentialRef !== credentialRef) throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Backend 未返回匹配的桌面设备引用', true)
    await this.options.runtimeStore.bindDesktop(accountId, { desktopRef, credentialRef })
    this.runtime = { ...runtime, desktopRef }
    const capabilities = [...new Set(runtime.capabilities.map(item => item.trim()).filter(Boolean))].sort()
    const capabilitiesHash = createHash('sha256').update(JSON.stringify(capabilities)).digest('base64url')
    const runtimeNonce = encodeBase64Url(randomBytes(32))
    const registeredRuntime = await this.options.controlPlane.registerRuntime(desktopRef, {
      profile_ref: this.options.profileRef, host_client_ref: this.options.hostClientRef,
      service_namespace: 'dsh_remote', service_name: 'host', protocol_major: 1,
      host_generation: runtime.hostGeneration, capabilities: runtime.capabilities,
      proof_nonce: runtimeNonce,
      proof_signature: signEd25519(identity.privateJwk, [
        'dsh-remote.runtime.register.v1', String(this.userId), String(this.clientId), desktopRef,
        this.options.profileRef, this.options.hostClientRef, String(runtime.hostGeneration), capabilitiesHash, runtimeNonce,
      ].join('\n')),
    })
    const backendRuntimeRef = typeof registeredRuntime.runtime_ref === 'string' ? registeredRuntime.runtime_ref : ''
    if (backendRuntimeRef === '') throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Backend 未返回 Runtime 引用', true)
    this.backendRuntimeRevision = typeof registeredRuntime.runtime_revision === 'number' && Number.isSafeInteger(registeredRuntime.runtime_revision)
      ? registeredRuntime.runtime_revision : 1
    this.runtime = { ...(await this.options.runtimeStore.adoptRuntimeRef(accountId, this.options.profileRef, backendRuntimeRef)), desktopRef }
    const policy = await this.options.controlPlane.updateRuntimePolicy(desktopRef, backendRuntimeRef, this.signedPolicy(true))
    if (typeof policy.runtime_revision === 'number' && Number.isSafeInteger(policy.runtime_revision)) {
      this.backendRuntimeRevision = policy.runtime_revision
    }
    const controller = new AbortController()
    await this.options.realtime.connect({ profileRef: this.options.profileRef, clientRef: this.options.hostClientRef, signal: controller.signal })
    const registered = await this.options.realtime.registerHost({ runtimeRef: backendRuntimeRef, capabilities: runtime.capabilities, signal: controller.signal })
    this.serviceLeaseGeneration = registered.serviceLeaseGeneration
    this.connected = true
    this.connectionError = undefined
    this.channelManager = new DshRemoteHostChannelManager({
      accountId, userId: this.userId, clientId: this.clientId,
      profileRef: this.options.profileRef, hostClientRef: this.options.hostClientRef,
      runtimeRef: backendRuntimeRef, credentialRef, identity,
      serviceLeaseGeneration: registered.serviceLeaseGeneration,
      grantSigningKeys: this.options.grantSigningKeys,
      controlPlane: this.options.controlPlane, realtime: this.options.realtime,
      credentialBroker: this.options.credentialBroker,
      dispatch: async (request, context) => await this.dispatchAuthorizedRequest(request, context),
      now: this.now,
    })
    for (const binding of this.bindings) {
      if (binding.status === 'active') await this.channelManager.open(binding).catch(() => undefined)
    }
  }

  private pairingHostClaims(pairingRef: string, issued: DshRemoteIssuedGrant): DshRemoteGrantClaims {
    const claims = verifyRemoteGrant(issued.grant, this.options.grantSigningKeys, {
      issuer: 'jotmo-backend/dsh-remote', audience: 'jotmo-realtime/remote-channel',
      nowSeconds: Math.floor(this.now() / 1000),
    })
    const pairing = this.pairing.secret(pairingRef)
    if (claims.grant_kind !== 'pairing' || claims.sender_role !== 'host' || claims.sub !== pairingRef
      || claims.user_id !== this.userId || claims.client_id !== this.clientId
      || claims.runtime_ref !== this.runtime!.runtimeRef || claims.credential_ref !== this.credentialRef
      || claims.host_profile_ref !== this.options.profileRef || claims.host_client_ref !== this.options.hostClientRef
      || claims.channel_ref !== pairing.pairingChannelRef
      || claims.cnf.key_fingerprint !== this.identity!.keyFingerprint || claims.cnf.public_key !== this.identity!.publicKey
      || !claims.allowed_directions.includes('pairing_confirm')) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Host Pairing Grant 与本机配对尝试不匹配')
    }
    if (claims.channel_ref !== this.pairingChannel?.claims.channel_ref && this.pairingChannel !== undefined
      || issued.channelRef !== undefined && issued.channelRef !== claims.channel_ref
      || pairing.grant.channelRef !== undefined && pairing.grant.channelRef !== claims.channel_ref) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Host Pairing Grant 频道不匹配')
    }
    return claims
  }

  private async openPairingChannel(pairingRef: string, issued: DshRemoteIssuedGrant): Promise<void> {
    const claims = this.pairingHostClaims(pairingRef, issued)
    const ticket = this.pairing.secret(pairingRef)
    if (claims.channel_ref !== ticket.grant.channelRef && ticket.grant.channelRef !== undefined) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Host Pairing Grant 未绑定已签名频道')
    }
    const controller = new AbortController()
    const authorization = await this.options.realtime.authorizeChannel({
      grant: issued.grant, claims,
      signProof: async transcript => signEd25519(this.identity!.privateJwk, transcript),
      signal: controller.signal,
    })
    if (authorization.serviceLeaseGeneration !== this.serviceLeaseGeneration) {
      controller.abort()
      throw new DshRemoteError('HOST_GENERATION_STALE', 'Pairing Grant 授权属于旧 Host lease', true)
    }
    const channel: HostPairingChannel = {
      pairingRef, claims, authorizationRef: authorization.authorizationRef,
      controller, unsubscribe: () => undefined, handling: false,
    }
    channel.unsubscribe = await this.options.realtime.subscribe({
      channelRef: claims.channel_ref, authorizationRef: authorization.authorizationRef,
      onEvent: (payload, metadata) => { void this.handlePairingClaim(channel, payload, metadata) },
      signal: controller.signal,
    })
    this.pairingChannel = channel
    this.schedulePairingGrantRenewal(channel)
  }

  private schedulePairingGrantRenewal(channel: HostPairingChannel): void {
    if (channel.renewTimer !== undefined) clearTimeout(channel.renewTimer)
    const lifetime = Math.max(1_000, (channel.claims.exp - channel.claims.iat) * 1000)
    channel.renewTimer = setTimeout(() => {
      if (this.pairingChannel === channel) void this.renewPairingChannel(channel).catch(() => {
        if (this.pairingChannel === channel) {
          this.closePairingChannel()
          this.pairing.clear(channel.pairingRef)
          this.bump()
        }
      })
    }, Math.max(1_000, Math.floor(lifetime * 0.6)))
    channel.renewTimer.unref()
  }

  private async renewPairingChannel(channel: HostPairingChannel): Promise<void> {
    const issued = await this.options.controlPlane.requestChannelGrant({
      grant_kind: 'pairing', subject_ref: channel.pairingRef, runtime_ref: this.runtime!.runtimeRef,
      credential_ref: this.credentialRef, sender_role: 'host',
    })
    const claims = this.pairingHostClaims(channel.pairingRef, issued)
    const authorization = await this.options.realtime.authorizeChannel({
      grant: issued.grant, claims,
      signProof: async transcript => signEd25519(this.identity!.privateJwk, transcript),
      signal: channel.controller.signal,
    })
    if (authorization.serviceLeaseGeneration !== this.serviceLeaseGeneration || this.pairingChannel !== channel) {
      throw new DshRemoteError('HOST_GENERATION_STALE', 'Pairing Grant 续约属于旧 Host lease', true)
    }
    channel.unsubscribe()
    channel.claims = claims
    channel.authorizationRef = authorization.authorizationRef
    channel.unsubscribe = await this.options.realtime.subscribe({
      channelRef: claims.channel_ref, authorizationRef: authorization.authorizationRef,
      onEvent: (payload, metadata) => { void this.handlePairingClaim(channel, payload, metadata) },
      signal: channel.controller.signal,
    })
    this.schedulePairingGrantRenewal(channel)
  }

  private async handlePairingClaim(
    channel: HostPairingChannel,
    payloadValue: DshRemoteRealtimePayload,
    metadata: DshRemoteTrustedEventMetadata,
  ): Promise<void> {
    if (this.pairingChannel !== channel || channel.handling || metadata.senderRole !== 'controller'
      || metadata.targetHostLeaseGeneration !== this.serviceLeaseGeneration || metadata.authorizationRef === ''
      || metadata.remoteAuthEpoch <= 0) return
    const payload = payloadValue as Record<string, unknown>
    if (payload.protocol !== 'dsh.remote-pairing' || payload.protocol_major !== 1 || payload.kind !== 'controller-claim') return
    channel.handling = true
    try {
      const allowed = new Set([
        'protocol', 'protocol_major', 'kind', 'pairing_ref', 'runtime_ref', 'challenge', 'claim_nonce',
        'controller_grant', 'controller_ephemeral_public_key', 'secret_kind', 'confirmation', 'signature',
      ])
      if (Object.keys(payload).some(key => !allowed.has(key))) throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller 配对 claim 含未知字段')
      const string = (key: string): string => {
        const value = payload[key]
        if (typeof value !== 'string' || value.trim() === '') throw new DshRemoteError('DEVICE_PROOF_INVALID', `Controller 配对 ${key} 无效`)
        return value
      }
      const controllerGrant = string('controller_grant')
      const controllerClaims = verifyRemoteGrant(controllerGrant, this.options.grantSigningKeys, {
        issuer: 'jotmo-backend/dsh-remote', audience: 'jotmo-realtime/remote-channel',
        nowSeconds: Math.floor(this.now() / 1000),
      })
      const secret = this.pairing.secret(channel.pairingRef)
      if (controllerClaims.grant_kind !== 'pairing' || controllerClaims.sender_role !== 'controller'
        || controllerClaims.user_id !== this.userId
        || controllerClaims.sub !== channel.pairingRef || controllerClaims.runtime_ref !== this.runtime!.runtimeRef
        || controllerClaims.host_profile_ref !== this.options.profileRef || controllerClaims.host_client_ref !== this.options.hostClientRef
        || controllerClaims.channel_ref !== channel.claims.channel_ref
        || controllerClaims.credential_ref !== metadata.senderCredentialRef
        || controllerClaims.subject_revisions.pairing !== metadata.subjectRevision
        || !controllerClaims.allowed_directions.includes('pairing_claim')
        || payload.pairing_ref !== channel.pairingRef || payload.runtime_ref !== this.runtime!.runtimeRef
        || payload.challenge !== secret.challenge) {
        throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller Pairing Grant 与当前尝试不匹配')
      }
      const controllerEphemeralPublicKey = string('controller_ephemeral_public_key')
      if (!/^[A-Za-z0-9_-]{43}$/.test(controllerEphemeralPublicKey)
        || decodeBase64Url(controllerEphemeralPublicKey).length !== 32) {
        throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller X25519 公钥无效')
      }
      const claimNonce = string('claim_nonce')
      const signature = string('signature')
      const unsigned = { ...payload }
      delete unsigned.signature
      if (!verifyEd25519(controllerClaims.cnf.public_key, canonicalJson(unsigned), signature)) {
        throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller 配对 claim 签名无效')
      }
      const expectedFingerprint = encodeBase64Url(sha256(decodeBase64Url(controllerClaims.cnf.public_key)))
      if (controllerClaims.cnf.key_fingerprint !== expectedFingerprint) {
        throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller Grant 公钥指纹不匹配')
      }
      const transcript = pairingTranscript({
        environment: this.options.environment, pairingRef: channel.pairingRef, challenge: secret.challenge, claimNonce,
        hostFingerprint: this.identity!.keyFingerprint, controllerFingerprint: controllerClaims.cnf.key_fingerprint,
      })
      const secretKind = payload.secret_kind
      const psk = secretKind === 'manual-code' ? pairingPsk(secret.manualCode)
        : secretKind === 'qr-challenge' ? sha256(secret.challenge)
          : (() => { throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Controller 配对 secret_kind 无效') })()
      const shared = deriveX25519(secret.privateJwk, controllerEphemeralPublicKey)
      const keys = deriveDirectionalKeys(shared, psk, transcript)
      if (!verifyPairingKeyConfirmation(keys.confirmation, transcript, 'controller', string('confirmation'))) {
        throw new DshRemoteError('PAIRING_KEY_CONFIRM_FAILED', 'Controller 配对密钥确认失败')
      }
      const hostConfirmation = {
        protocol: 'dsh.remote-pairing', protocol_major: 1, kind: 'host-key-confirm',
        pairing_ref: channel.pairingRef, runtime_ref: this.runtime!.runtimeRef, claim_nonce: claimNonce,
        host_fingerprint: this.identity!.keyFingerprint, controller_fingerprint: controllerClaims.cnf.key_fingerprint,
        host_public_signing_key: this.identity!.publicKey,
        confirmation: pairingKeyConfirmation(keys.confirmation, transcript, 'host'),
      }
      await this.options.realtime.publish({
        channelRef: channel.claims.channel_ref, authorizationRef: channel.authorizationRef,
        commandId: `pairing_confirm_${channel.pairingRef}`, direction: 'pairing_confirm',
        payload: { ...hostConfirmation, signature: signEd25519(this.identity!.privateJwk, canonicalJson(hostConfirmation)) },
        signal: channel.controller.signal,
      })
      const transcriptHash = sha256(transcript).toString('hex')
      const confirmed = await this.options.controlPlane.confirmPairing(channel.pairingRef, {
        claim_nonce: claimNonce, transcript_hash: transcriptHash,
        proof_signature: signEd25519(this.identity!.privateJwk, [
          'dsh-remote.pairing.host-confirm.v1', String(this.userId), String(this.clientId),
          channel.pairingRef, claimNonce, transcriptHash,
        ].join('\n')),
      })
      const controlClaims = verifyRemoteGrant(confirmed.grant.grant, this.options.grantSigningKeys, {
        issuer: 'jotmo-backend/dsh-remote', audience: 'jotmo-realtime/remote-channel',
        nowSeconds: Math.floor(this.now() / 1000),
      })
      if (confirmed.binding.status !== 'active' || confirmed.binding.controllerCredentialRef !== controllerClaims.credential_ref
        || controlClaims.grant_kind !== 'control' || controlClaims.sender_role !== 'host'
        || controlClaims.user_id !== this.userId || controlClaims.client_id !== this.clientId
        || controlClaims.sub !== confirmed.binding.bindingRef || controlClaims.runtime_ref !== this.runtime!.runtimeRef
        || controlClaims.host_profile_ref !== this.options.profileRef || controlClaims.host_client_ref !== this.options.hostClientRef
        || controlClaims.credential_ref !== this.credentialRef || controlClaims.cnf.public_key !== this.identity!.publicKey
        || controlClaims.cnf.key_fingerprint !== this.identity!.keyFingerprint
        || controlClaims.subject_revisions.binding !== confirmed.binding.revision
        || !controlClaims.allowed_directions.includes('response')
        || controlClaims.scope.length !== confirmed.binding.scopes.length
        || controlClaims.scope.some(scope => !confirmed.binding.scopes.includes(scope))
        || confirmed.grant.channelRef !== undefined && confirmed.grant.channelRef !== controlClaims.channel_ref) {
        throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Backend host-confirm 返回的 Binding/Grant 不匹配')
      }
      await this.options.credentialBroker.putChannelKeys({
        accountId: this.accountId!, bindingRef: confirmed.binding.bindingRef,
        runtimeRef: this.runtime!.runtimeRef, channelRef: controlClaims.channel_ref,
        keyEpoch: 1, rootSecret: keys.confirmation,
        controllerPublicKey: controllerClaims.cnf.public_key,
        controllerKeyFingerprint: controllerClaims.cnf.key_fingerprint,
        controllerToHost: keys.controllerToHost, hostToController: keys.hostToController,
      })
      this.bindings = [...this.bindings.filter(item => item.bindingRef !== confirmed.binding.bindingRef), confirmed.binding]
      await this.options.runtimeStore.upsertBindings(this.accountId!, this.bindings)
      this.closePairingChannel()
      this.pairing.clear(channel.pairingRef)
      await this.channelManager?.open(confirmed.binding, confirmed.grant)
      this.bump()
    } catch {
      // Keep a claimed attempt alive for an idempotent retry until its 10-minute expiry.
    } finally {
      if (this.pairingChannel === channel) channel.handling = false
    }
  }

  private closePairingChannel(): void {
    const channel = this.pairingChannel
    if (channel === undefined) return
    this.pairingChannel = undefined
    if (channel.renewTimer !== undefined) clearTimeout(channel.renewTimer)
    channel.controller.abort()
    channel.unsubscribe()
  }

  private signedPolicy(enabled: boolean): Record<string, unknown> {
    const runtime = this.runtime!
    const nonce = encodeBase64Url(randomBytes(32))
    const expectedRevision = this.backendRuntimeRevision
    return {
      expected_revision: expectedRevision, remote_enabled: enabled, proof_nonce: nonce,
      proof_signature: signEd25519(this.identity!.privateJwk, [
        'dsh-remote.runtime.policy.v1', String(this.userId), String(this.clientId), runtime.desktopRef ?? '',
        runtime.runtimeRef, String(expectedRevision), String(enabled), nonce,
      ].join('\n')),
    }
  }

  private async dispatch(request: DshRemoteRequest, bindingRef: string): Promise<{ duplicate: boolean; value: unknown }> {
    switch (request.operation) {
      case 'capabilities.get': return { duplicate: false, value: { capabilities: this.options.apiProxy.capabilities() } }
      case 'snapshot.get': {
        const cursor = optionalString(request.body, 'cursor')
        const limit = optionalPositive(request.body, 'limit')
        return { duplicate: false, value: await this.options.apiProxy.snapshot({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }) }
      }
      case 'workspace.list': {
        const cursor = optionalString(request.body, 'cursor')
        const limit = optionalPositive(request.body, 'limit')
        return { duplicate: false, value: await this.options.apiProxy.workspacePage({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }) }
      }
      case 'session.list': {
        const workspaceId = optionalString(request.body, 'workspace_ref')
        const cursor = optionalString(request.body, 'cursor')
        const limit = optionalPositive(request.body, 'limit')
        return { duplicate: false, value: await this.options.apiProxy.sessions({
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }) }
      }
      case 'session.history': {
        const beforeSeq = optionalPositive(request.body, 'before_seq')
        const limit = optionalPositive(request.body, 'limit')
        return { duplicate: false, value: await this.options.apiProxy.history({
          sessionId: stringBody(request.body, 'session_ref'),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(limit === undefined ? {} : { limit }),
        }) }
      }
      default: return await this.dispatchWrite(request, bindingRef)
    }
  }

  private async dispatchWrite(request: DshRemoteRequest, bindingRef: string): Promise<{ duplicate: boolean; value: unknown }> {
    const ledger = this.ledger
    if (ledger === undefined) throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控命令账本尚未就绪')
    const begun = ledger.begin({
      accountId: this.accountId!, bindingRef, runtimeRef: this.runtime!.runtimeRef, requestRef: request.request_ref,
      operation: request.operation, arguments: request.body, executeBeforeMillis: request.execute_before,
    })
    if (begun.duplicate) {
      if (begun.entry.state === 'completed') return { duplicate: true, value: resultFromLedger(begun.entry) }
      throw new DshRemoteError('COMMAND_OUTCOME_UNKNOWN', '同一命令的结果尚未完成对账')
    }
    const identity = { accountId: this.accountId!, bindingRef, runtimeRef: this.runtime!.runtimeRef, requestRef: request.request_ref }
    let value: unknown
    try {
      switch (request.operation) {
      case 'session.create': value = await this.options.apiProxy.createSession({
        workspaceId: stringBody(request.body, 'workspace_ref'), requestRef: request.request_ref, dshRpcId: begun.entry.dshRpcId,
      }); break
      case 'session.prompt': value = await this.options.apiProxy.prompt({
        sessionId: stringBody(request.body, 'session_ref'),
        mode: request.body.mode === 'queue' || request.body.mode === 'steer' ? request.body.mode : (() => { throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'prompt mode 无效') })(),
        content: [request.body.content], dshRpcId: begun.entry.dshRpcId,
      }); break
      case 'session.cancel': value = await this.options.apiProxy.cancel({
        sessionId: stringBody(request.body, 'session_ref'), dshRpcId: begun.entry.dshRpcId,
      }); break
      case 'interaction.question.respond': await this.options.apiProxy.answerQuestion({
        interactionRpcRef: stringBody(request.body, 'interaction_rpc_ref'), sessionId: stringBody(request.body, 'session_ref'),
        answer: request.body.answer,
      }); value = { accepted: true }; break
      case 'interaction.approval.respond': await this.options.apiProxy.answerApproval({
        interactionRpcRef: stringBody(request.body, 'interaction_rpc_ref'), sessionId: stringBody(request.body, 'session_ref'),
        approvalId: stringBody(request.body, 'approval_id'),
        outcome: request.body.outcome === 'allowed-once' || request.body.outcome === 'rejected'
          ? request.body.outcome : (() => { throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'approval outcome 无效') })(),
      }); value = { accepted: true }; break
        default: throw new DshRemoteError('CAPABILITY_UNSUPPORTED', '远控操作不受支持')
      }
    } catch (error) {
      const known = error instanceof DshRemoteError
        && (error.code !== 'REMOTE_TRANSPORT_FAILED' || error.details.dshRejected === true)
      if (known) ledger.completeRejected(identity, error)
      else ledger.markOutcomeUnknown(identity, 'DSH transport failed after the command ledger entered pending')
      throw error
    }
    ledger.complete(identity, { value })
    return { duplicate: false, value }
  }

  private async reconcileUnsettled(): Promise<void> {
    if (this.ledger === undefined || this.accountId === undefined) return
    for (const entry of this.ledger.unsettledForReconciliation(this.accountId, this.now())) {
      const argumentsValue = entry.payload.arguments
      const argumentsRecord = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
        ? argumentsValue as Record<string, unknown> : undefined
      const sessionId = argumentsValue !== null && typeof argumentsValue === 'object' && typeof (argumentsValue as Record<string, unknown>).session_ref === 'string'
        ? (argumentsValue as Record<string, unknown>).session_ref as string : undefined
      let proven = false
      let recoveredValue: Record<string, unknown> = { recovered: true, dshRpcId: entry.dshRpcId }
      if (entry.operation === 'session.create' && typeof argumentsRecord?.workspace_ref === 'string') {
        try {
          const created = await this.options.apiProxy.reconcileCreatedSession({
            workspaceId: argumentsRecord.workspace_ref,
            requestRef: entry.requestRef,
          })
          if (created !== undefined) {
            proven = true
            recoveredValue = { recovered: true, sessionId: created.sessionId }
          }
        } catch { /* An unavailable list cannot prove a safe result. */ }
      }
      if (sessionId !== undefined) {
        try {
          const history = await this.options.apiProxy.history({ sessionId, limit: 50 })
          proven = this.options.apiProxy.historyContainsRpcId(history.entries, entry.dshRpcId)
        } catch { /* Absence or unavailable history cannot prove a safe retry. */ }
      }
      const identity = { accountId: entry.accountId, bindingRef: entry.bindingRef, runtimeRef: entry.runtimeRef, requestRef: entry.requestRef }
      if (proven) this.ledger.complete(identity, { value: recoveredValue })
      else this.ledger.markOutcomeUnknown(identity, 'DSH history did not prove the accepted result after Host recovery')
    }
  }

  private requireReady(): void {
    if (!this.started || this.accountId === undefined || this.runtime === undefined || this.identity === undefined) {
      throw new DshRemoteError('REMOTE_LOGIN_REQUIRED', '请先登录 Arkme 后再配置远控')
    }
  }

  private requireConnected(): void {
    this.requireReady()
    if (!this.runtime!.remoteEnabled) throw new DshRemoteError('REMOTE_DISABLED', '当前 Runtime 未开启远控')
    if (!this.connected || this.serviceLeaseGeneration <= 0) throw new DshRemoteError('RUNTIME_OFFLINE', '当前 Runtime 未连接 Realtime', true)
  }

  private bump(): void {
    this.revision++
    const snapshot = this.getStatus()
    for (const listener of this.listeners) listener(snapshot)
  }
}
