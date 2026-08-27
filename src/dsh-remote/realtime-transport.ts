import { randomUUID } from 'node:crypto'
import { channelPopTranscript } from './crypto.js'
import { DshRemoteError } from './errors.js'
import type {
  DshRemoteCapability,
  DshRemoteChannelAuthorization,
  DshRemoteGrantClaims,
  DshRemotePublishDirection,
  DshRemoteRealtimePayload,
  DshRemoteRealtimeTransport,
  DshRemoteTrustedEventMetadata,
} from './types.js'
import { DSH_REMOTE_MAX_FRAME_BYTES } from './types.js'

interface SocketEventLike { data?: unknown }
export interface DshRemoteSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: SocketEventLike) => void): void
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: SocketEventLike) => void): void
}

export type DshRemoteSocketFactory = (
  input: { profileRef: string; clientRef: string; signal: AbortSignal },
) => DshRemoteSocketLike | Promise<DshRemoteSocketLike>

interface ServerFrame extends Record<string, unknown> {
  type: string
  request_id?: string
}

interface AuthorizationFrameContext {
  claims: DshRemoteGrantClaims
  remoteAuthEpoch: number
}

export interface DshRemoteFrameSizingInput {
  channelRef: string
  authorizationRef: string
  commandId: string
  direction: DshRemotePublishDirection
  payload: DshRemoteRealtimePayload
  senderRole: 'host' | 'controller'
  senderCredentialRef: string
  subjectRevision: number
  remoteAuthEpoch: number
  targetHostLeaseGeneration: number
}

/**
 * Mirrors jotmo-realtime's frozen channel.publish and channel.event JSON
 * wrappers. Max-width sequence/timestamp values make this conservative while
 * still accounting for the actual ciphertext/base64 and duplicated metadata.
 */
export function dshRemoteFrameByteLengths(input: DshRemoteFrameSizingInput): { publish: number; event: number } {
  const maxInt64 = 9_223_372_036_854_776_000
  const requestId = '00000000-0000-4000-8000-000000000000'
  const publish = {
    type: 'channel.publish', namespace: 'dsh_remote', channel_ref: input.channelRef,
    authorization_ref: input.authorizationRef, direction: input.direction,
    command_id: input.commandId, payload: input.payload, request_id: requestId,
  }
  const event = {
    type: 'channel.event', namespace: 'dsh_remote', channel_ref: input.channelRef, seq: maxInt64,
    event: {
      channel_ref: input.channelRef, command_id: input.commandId, seq: maxInt64,
      sender_role: input.senderRole, sender_credential_ref: input.senderCredentialRef,
      authorization_ref: input.authorizationRef, subject_revision: input.subjectRevision,
      remote_auth_epoch: input.remoteAuthEpoch, accepted_at: maxInt64,
      target_host_lease_generation: input.targetHostLeaseGeneration,
      payload: input.payload, created_at: maxInt64,
    },
  }
  return {
    publish: Buffer.byteLength(JSON.stringify(publish)),
    event: Buffer.byteLength(JSON.stringify(event)),
  }
}

export function assertDshRemoteFramesFit(input: DshRemoteFrameSizingInput): void {
  const sizes = dshRemoteFrameByteLengths(input)
  if (sizes.publish > DSH_REMOTE_MAX_FRAME_BYTES || sizes.event > DSH_REMOTE_MAX_FRAME_BYTES) {
    throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'Realtime 加密 publish/event frame 超过 60KiB')
  }
}

const SERVER_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'connection.ready': new Set(['type', 'connection_generation']),
  'connection.replaced': new Set(['type', 'connection_generation']),
  'service.registered': new Set(['type', 'request_id', 'namespace', 'service', 'protocol', 'protocol_major', 'connection_generation', 'duplicate']),
  'service.unregistered': new Set(['type', 'request_id', 'namespace', 'service', 'protocol', 'protocol_major', 'duplicate']),
  'channel.authorize.challenge': new Set(['type', 'request_id', 'authorization_ref', 'nonce', 'expires_at']),
  'channel.authorized': new Set(['type', 'request_id', 'authorization_ref', 'sender_role', 'remote_auth_epoch', 'expires_at', 'fence_revisions']),
  'channel.subscribed': new Set(['type', 'request_id', 'namespace', 'channel_ref', 'seq', 'duplicate', 'authorization_ref']),
  'channel.published': new Set(['type', 'request_id', 'namespace', 'channel_ref', 'seq', 'duplicate', 'authorization_ref']),
  'channel.event': new Set(['type', 'namespace', 'channel_ref', 'seq', 'event']),
  'channel.authorization.expired': new Set(['type', 'channel_ref', 'authorization_ref', 'code', 'message', 'retryable']),
  'channel.authorization.revoked': new Set(['type', 'channel_ref', 'authorization_ref', 'code', 'message', 'retryable']),
  error: new Set(['type', 'request_id', 'channel_ref', 'code', 'message', 'retryable']),
}

function validServerFrame(frame: ServerFrame): boolean {
  const allowed = SERVER_FIELDS[frame.type]
  if (allowed === undefined || Object.keys(frame).some(key => !allowed.has(key))) return false
  if (frame.type === 'connection.ready') return typeof frame.connection_generation === 'number'
  if (frame.type === 'channel.event') return frame.namespace === 'dsh_remote' && typeof frame.channel_ref === 'string'
    && typeof frame.seq === 'number' && Number.isSafeInteger(frame.seq) && frame.seq > 0
    && frame.event !== null && typeof frame.event === 'object' && !Array.isArray(frame.event)
  if (frame.type === 'connection.replaced' || frame.type === 'channel.authorization.expired'
    || frame.type === 'channel.authorization.revoked') return true
  return typeof frame.request_id === 'string' && frame.request_id !== ''
}

function remoteError(frame: ServerFrame): DshRemoteError {
  const code = typeof frame.code === 'string' ? frame.code : 'REMOTE_TRANSPORT_FAILED'
  const supported = new Set([
    'RUNTIME_OFFLINE', 'HOST_CHANNEL_NOT_READY', 'REMOTE_DISABLED', 'BINDING_REVOKED',
    'CHANNEL_GRANT_EXPIRED', 'REMOTE_AUTH_EPOCH_STALE', 'CONNECTION_REPLACED', 'HOST_GENERATION_STALE',
    'DEVICE_CREDENTIAL_REVOKED', 'DEVICE_PROOF_INVALID', 'REMOTE_PROTOCOL_UNSUPPORTED', 'REPLAY_GAP',
  ])
  return new DshRemoteError(
    (supported.has(code) ? code : 'REMOTE_TRANSPORT_FAILED') as ConstructorParameters<typeof DshRemoteError>[0],
    typeof frame.message === 'string' && frame.message.trim() !== '' ? frame.message : 'Realtime 远控操作失败',
    frame.retryable === true,
  )
}

function positive(frame: ServerFrame, key: string): number {
  const value = frame[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', `Realtime ${key} 无效`, true)
  }
  return value
}

/** Exact adapter for jotmo-realtime's connection.open -> ready remote frame contract. */
export class ArkmeRemoteRealtimeTransport implements DshRemoteRealtimeTransport {
  private socket: DshRemoteSocketLike | undefined
  private connectionGeneration = 0
  private readonly waiters = new Map<string, { resolve: (frame: ServerFrame) => void; reject: (error: Error) => void }>()
  private readonly channelListeners = new Map<string, (frame: ServerFrame) => void>()
  private readonly disconnectListeners = new Set<(error: Error) => void>()
  private readonly authorizationContexts = new Map<string, AuthorizationFrameContext>()
  private onMessage: ((event: SocketEventLike) => void) | undefined
  private onClose: ((event: SocketEventLike) => void) | undefined

  constructor(
    private readonly createSocket: DshRemoteSocketFactory,
    private readonly requestTimeoutMillis = 10_000,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMillis) || requestTimeoutMillis < 1_000 || requestTimeoutMillis > 60_000) {
      throw new TypeError('Realtime request timeout must be between 1000 and 60000 milliseconds')
    }
  }

  async connect(input: { profileRef: string; clientRef: string; signal: AbortSignal }): Promise<void> {
    await this.disconnect()
    if (input.signal.aborted) throw input.signal.reason
    const socket = await this.createSocket(input)
    this.socket = socket
    this.onMessage = event => { this.receive(event.data) }
    this.onClose = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.connectionGeneration = 0
      const error = new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 连接意外关闭', true)
      for (const waiter of this.waiters.values()) waiter.reject(error)
      this.waiters.clear()
      this.channelListeners.clear()
      this.authorizationContexts.clear()
      for (const listener of this.disconnectListeners) listener(error)
    }
    socket.addEventListener('message', this.onMessage)
    socket.addEventListener('close', this.onClose)
    const opened = await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 连接失败', true)) }
      const onEarlyClose = () => { cleanup(); reject(new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 在握手前关闭', true)) }
      const onAbort = () => { cleanup(); socket.close(1000, 'aborted'); reject(input.signal.reason) }
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onEarlyClose)
        input.signal.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.close(1000, 'handshake timeout')
        reject(new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 连接握手超时', true))
      }, this.requestTimeoutMillis)
      timer.unref()
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onEarlyClose)
      input.signal.addEventListener('abort', onAbort, { once: true })
    })
    void opened
    const ready = this.waitForType('connection.ready', input.signal)
    this.send({ type: 'connection.open', profile_ref: input.profileRef, client_ref: input.clientRef })
    this.connectionGeneration = positive(await ready, 'connection_generation')
  }

  async disconnect(): Promise<void> {
    const socket = this.socket
    if (socket !== undefined && this.onMessage !== undefined) socket.removeEventListener('message', this.onMessage)
    if (socket !== undefined && this.onClose !== undefined) socket.removeEventListener('close', this.onClose)
    this.socket = undefined
    this.onMessage = undefined
    this.onClose = undefined
    this.connectionGeneration = 0
    socket?.close(1000, 'remote host stopped')
    const error = new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 连接已关闭', true)
    for (const waiter of this.waiters.values()) waiter.reject(error)
    this.waiters.clear()
    this.channelListeners.clear()
    this.authorizationContexts.clear()
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  async registerHost(input: { runtimeRef: string; capabilities: DshRemoteCapability[]; signal: AbortSignal }): Promise<{ serviceLeaseGeneration: number }> {
    void input.runtimeRef
    void input.capabilities
    const frame = await this.request({
      type: 'service.register', namespace: 'dsh_remote', service: 'host', protocol: 'dsh.remote', protocol_major: 1,
      participant_min: 2, participant_max: 2,
    }, 'service.registered', input.signal)
    return { serviceLeaseGeneration: positive(frame, 'connection_generation') }
  }

  async unregisterHost(signal?: AbortSignal): Promise<void> {
    if (this.socket === undefined) return
    await this.request({
      type: 'service.unregister', namespace: 'dsh_remote', service: 'host', protocol: 'dsh.remote', protocol_major: 1,
    }, 'service.unregistered', signal ?? new AbortController().signal)
  }

  async authorizeChannel(input: {
    grant: string
    claims: DshRemoteGrantClaims
    signProof: (transcript: string) => Promise<string>
    signal: AbortSignal
  }): Promise<DshRemoteChannelAuthorization> {
    const start = await this.request({
      type: 'channel.authorize.start', grant: input.grant, channel_ref: input.claims.channel_ref,
    }, 'channel.authorize.challenge', input.signal)
    const authorizationRef = typeof start.authorization_ref === 'string' ? start.authorization_ref : ''
    const nonce = typeof start.nonce === 'string' ? start.nonce : ''
    if (authorizationRef === '' || nonce === '') throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime PoP challenge 无效', true)
    const proof = await input.signProof(channelPopTranscript({
      grantJti: input.claims.jti, channelRef: input.claims.channel_ref, senderRole: input.claims.sender_role,
      authorizationRef, connectionGeneration: this.connectionGeneration, nonce,
    }))
    const authorized = await this.request({ type: 'channel.authorize.prove', authorization_ref: authorizationRef, proof }, 'channel.authorized', input.signal)
    if (authorized.authorization_ref !== authorizationRef) throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Realtime PoP 授权引用不匹配')
    const remoteAuthEpoch = positive(authorized, 'remote_auth_epoch')
    for (const [ref, context] of this.authorizationContexts) {
      if (context.claims.channel_ref === input.claims.channel_ref
        && context.claims.sender_role === input.claims.sender_role
        && context.claims.credential_ref === input.claims.credential_ref) this.authorizationContexts.delete(ref)
    }
    this.authorizationContexts.set(authorizationRef, { claims: input.claims, remoteAuthEpoch })
    return {
      authorizationRef,
      remoteAuthEpoch,
      serviceLeaseGeneration: this.connectionGeneration,
      expiresAtMillis: positive(authorized, 'expires_at'),
    }
  }

  async subscribe(input: {
    channelRef: string
    authorizationRef: string
    afterSequence?: number
    onEvent: (payload: DshRemoteRealtimePayload, metadata: DshRemoteTrustedEventMetadata) => void
    signal: AbortSignal
  }): Promise<() => void> {
    if (input.afterSequence !== undefined
      && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)) {
      throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'Realtime after_seq 无效')
    }
    await this.request({
      type: 'channel.subscribe', namespace: 'dsh_remote', channel_ref: input.channelRef,
      authorization_ref: input.authorizationRef,
      ...(input.afterSequence === undefined ? {} : { after_seq: input.afterSequence }),
    }, 'channel.subscribed', input.signal)
    this.channelListeners.set(input.channelRef, frame => {
      const event = frame.event
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return
      const source = event as Record<string, unknown>
      if (source.payload === null || typeof source.payload !== 'object' || Array.isArray(source.payload)) return
      if (source.sender_role !== 'host' && source.sender_role !== 'controller') return
      if (typeof source.sender_credential_ref !== 'string' || source.sender_credential_ref === ''
        || typeof source.authorization_ref !== 'string' || source.authorization_ref === ''
        || typeof source.subject_revision !== 'number' || !Number.isSafeInteger(source.subject_revision) || source.subject_revision <= 0
        || typeof source.remote_auth_epoch !== 'number' || !Number.isSafeInteger(source.remote_auth_epoch) || source.remote_auth_epoch <= 0
        || typeof source.accepted_at !== 'number' || !Number.isSafeInteger(source.accepted_at) || source.accepted_at <= 0
        || typeof source.target_host_lease_generation !== 'number' || !Number.isSafeInteger(source.target_host_lease_generation)
        || source.target_host_lease_generation <= 0) return
      input.onEvent(source.payload as Record<string, unknown>, {
        senderRole: source.sender_role,
        senderCredentialRef: source.sender_credential_ref,
        authorizationRef: source.authorization_ref,
        subjectRevision: source.subject_revision,
        remoteAuthEpoch: source.remote_auth_epoch,
        acceptedAtMillis: source.accepted_at,
        targetHostLeaseGeneration: source.target_host_lease_generation,
        ...(typeof source.seq === 'number' && Number.isSafeInteger(source.seq) && source.seq > 0
          ? { transportSequence: source.seq } : {}),
      })
      if (typeof source.seq === 'number') this.send({
        type: 'channel.ack', request_id: randomUUID(), namespace: 'dsh_remote', channel_ref: input.channelRef, seq: source.seq,
      })
    })
    const unsubscribe = () => {
      if (this.channelListeners.get(input.channelRef) !== undefined) this.channelListeners.delete(input.channelRef)
      if (this.socket !== undefined) this.send({
        type: 'channel.unsubscribe', request_id: randomUUID(), namespace: 'dsh_remote', channel_ref: input.channelRef,
      })
    }
    input.signal.addEventListener('abort', unsubscribe, { once: true })
    return unsubscribe
  }

  async publish(input: {
    channelRef: string
    authorizationRef: string
    commandId: string
    direction: DshRemotePublishDirection
    payload: DshRemoteRealtimePayload
    signal: AbortSignal
  }): Promise<{ sequence: number }> {
    const authorization = this.authorizationContexts.get(input.authorizationRef)
    if (authorization === undefined) throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Realtime 发布缺少本连接授权上下文')
    const revisionKey = authorization.claims.grant_kind === 'control' ? 'binding' : 'pairing'
    const subjectRevision = authorization.claims.subject_revisions[revisionKey]
    if (!Number.isSafeInteger(subjectRevision) || subjectRevision! <= 0) {
      throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Realtime Grant 缺少有效 subject revision')
    }
    assertDshRemoteFramesFit({
      channelRef: input.channelRef, authorizationRef: input.authorizationRef,
      commandId: input.commandId, direction: input.direction, payload: input.payload,
      senderRole: authorization.claims.sender_role,
      senderCredentialRef: authorization.claims.credential_ref,
      subjectRevision: subjectRevision!, remoteAuthEpoch: authorization.remoteAuthEpoch,
      targetHostLeaseGeneration: this.connectionGeneration,
    })
    const frame = await this.request({
      type: 'channel.publish', namespace: 'dsh_remote', channel_ref: input.channelRef,
      authorization_ref: input.authorizationRef, direction: input.direction,
      command_id: input.commandId, payload: input.payload,
    }, 'channel.published', input.signal)
    return { sequence: positive(frame, 'seq') }
  }

  private async request(frame: Record<string, unknown>, expectedType: string, signal: AbortSignal): Promise<ServerFrame> {
    const requestId = randomUUID()
    const response = this.waitForRequest(requestId, expectedType, signal)
    this.send({ ...frame, request_id: requestId })
    return await response
  }

  private waitForRequest(requestId: string, expectedType: string, signal: AbortSignal): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => { this.waiters.delete(requestId); cleanup(); reject(signal.reason) }
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        cleanup()
        reject(new DshRemoteError('REMOTE_TRANSPORT_FAILED', `Realtime ${expectedType} 响应超时`, true))
      }, this.requestTimeoutMillis)
      timer.unref()
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(requestId, {
        resolve: frame => {
          cleanup()
          if (frame.type !== expectedType) reject(remoteError(frame))
          else resolve(frame)
        },
        reject: error => { cleanup(); reject(error) },
      })
    })
  }

  private waitForType(type: string, signal: AbortSignal): Promise<ServerFrame> {
    return this.waitForRequest(`@type:${type}`, type, signal)
  }

  private receive(data: unknown): void {
    let frame: ServerFrame
    try {
      const raw = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data)
      if (Buffer.byteLength(raw) > DSH_REMOTE_MAX_FRAME_BYTES) return
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') return
      frame = parsed as ServerFrame
    } catch { return }
    const requestId = frame.request_id
    const waiterKey = typeof requestId === 'string' && this.waiters.has(requestId) ? requestId : `@type:${frame.type}`
    const waiter = this.waiters.get(waiterKey)
    if (waiter !== undefined) {
      this.waiters.delete(waiterKey)
      if (!validServerFrame(frame)) waiter.reject(new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 响应不符合冻结协议', true))
      else waiter.resolve(frame)
      return
    }
    if (!validServerFrame(frame)) return
    if (frame.type === 'channel.event' && typeof frame.channel_ref === 'string') this.channelListeners.get(frame.channel_ref)?.(frame)
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket === undefined || this.socket.readyState !== 1) throw new DshRemoteError('REMOTE_TRANSPORT_FAILED', 'Realtime 尚未连接', true)
    const encoded = JSON.stringify(frame)
    if (Buffer.byteLength(encoded) > DSH_REMOTE_MAX_FRAME_BYTES) throw new DshRemoteError('REMOTE_REQUEST_INVALID', 'Realtime frame 超过 60KiB')
    this.socket.send(encoded)
  }
}
