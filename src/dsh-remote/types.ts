import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto'

export const DSH_REMOTE_PROTOCOL = 'dsh.remote' as const
export const DSH_REMOTE_PROTOCOL_MAJOR = 1 as const
export const DSH_REMOTE_PAIRING_TTL_MS = 10 * 60_000
export const DSH_REMOTE_PAIRING_GRANT_TTL_SECONDS = 120
export const DSH_REMOTE_CONTROL_GRANT_TTL_SECONDS = 120
export const DSH_REMOTE_CLOCK_SKEW_SECONDS = 30
export const DSH_REMOTE_KEY_ROTATION_MS = 30 * 60_000
export const DSH_REMOTE_MAX_FRAME_BYTES = 60 * 1024
export const DSH_REMOTE_MAX_PAGE_ITEMS = 50
// The v4 contract keeps a 512 KiB logical snapshot-page ceiling, but the
// encrypted Realtime frame is the tighter boundary. Read projections therefore
// stop at the conservative inner-result budget below before this ceiling can be
// reached.
export const DSH_REMOTE_MAX_SNAPSHOT_BYTES = 512 * 1024
export const DSH_REMOTE_MAX_PAGE_RESULT_BYTES = 40 * 1024
export const DSH_REMOTE_MAX_TEXT_CODE_POINTS = 20_000

export type DshRemoteCapability =
  | 'workspace.list'
  | 'session.list'
  | 'session.create'
  | 'session.history'
  | 'session.prompt'
  | 'session.prompt.queue'
  | 'session.prompt.steer'
  | 'session.cancel'
  | 'session.events'
  | 'interaction.question.respond'
  | 'interaction.approval.respond'

export type DshRemoteOperation =
  | 'capabilities.get'
  | 'snapshot.get'
  | 'workspace.list'
  | 'session.list'
  | 'session.create'
  | 'session.history'
  | 'session.prompt'
  | 'session.cancel'
  | 'interaction.question.respond'
  | 'interaction.approval.respond'

export type DshRemoteRequestKind = 'request'
export type DshRemoteResponseStatus = 'accepted' | 'completed' | 'rejected' | 'duplicate'

export interface DshRemoteRequest {
  protocol: typeof DSH_REMOTE_PROTOCOL
  protocol_major: typeof DSH_REMOTE_PROTOCOL_MAJOR
  kind: DshRemoteRequestKind
  request_ref: string
  host_generation: number
  issued_at: number
  execute_before: number
  operation: DshRemoteOperation
  body: Record<string, unknown>
}

export interface DshRemoteResponse {
  protocol: typeof DSH_REMOTE_PROTOCOL
  protocol_major: typeof DSH_REMOTE_PROTOCOL_MAJOR
  kind: 'response'
  request_ref: string
  status: DshRemoteResponseStatus
  host_generation: number
  issued_at: number
  operation: DshRemoteOperation
  body: Record<string, unknown>
  session_seq?: number
  projection_as_of_seq?: number
  result?: unknown
  error?: {
    code: string
    message: string
    retryable: boolean
    trace_ref: string
  }
}

export interface DshRemoteDeviceKeyMaterial {
  schemaVersion: 1
  algorithm: 'Ed25519'
  accountId: string
  publicKey: string
  keyFingerprint: string
  privateJwk: NodeJsonWebKey
  keyEpoch: number
  createdAtMillis: number
}

export interface DshRemoteDesktopIdentity {
  desktopRef?: string
  credentialRef?: string
  accountId: string
  displayName: string
  platform: NodeJS.Platform
  keyEpoch: number
  keyFingerprint: string
  publicKey: string
}

export interface DshRemoteRuntimeProjection {
  runtimeRef: string
  desktopRef?: string
  profileRef: string
  accountId: string
  remoteEnabled: boolean
  hostGeneration: number
  capabilities: DshRemoteCapability[]
  updatedAtMillis: number
}

export interface DshRemoteBindingProjection {
  bindingRef: string
  controllerCredentialRef: string
  controllerDisplayName: string
  controllerPlatform: string
  revision: number
  status: 'active' | 'suspended' | 'revoked'
  scopes: string[]
  boundAtMillis: number
  lastUsedAtMillis?: number
}

export interface DshRemotePairingTicket {
  pairingRef: string
  pairingChannelRef: string
  qrPayload: string
  pairingCode: string
  hostKeyFingerprint: string
  expiresAtMillis: number
  runtimeRef: string
}

export interface DshRemotePairingQrPayload {
  scheme: 'jotmo-dsh-remote'
  version: 1
  environment: 'test' | 'production'
  pairing_ref: string
  challenge: string
  expires_at: number
  host_fingerprint: string
  host_public_signing_key: string
  host_ephemeral_public_key: string
  host_signature: string
}

export interface DshRemoteStatus {
  contractVersion: 1
  available: boolean
  enabled: boolean
  connected: boolean
  accountId?: string
  desktopRef?: string
  runtimeRef?: string
  hostGeneration: number
  capabilities: DshRemoteCapability[]
  bindings: DshRemoteBindingProjection[]
  pairingAttempt?: Omit<DshRemotePairingTicket, 'pairingCode'> & { pairingCode: string }
  unavailableReason?: string
  revision: number
}

export interface DshRemotePairingTranscriptInput {
  environment: string
  pairingRef: string
  challenge: string
  claimNonce: string
  hostFingerprint: string
  controllerFingerprint: string
}

export interface DshRemoteGrantClaims {
  iss: string
  aud: string
  sub: string
  jti: string
  iat: number
  nbf: number
  exp: number
  user_id: number
  client_id: number
  grant_kind: 'pairing' | 'control'
  channel_ref: string
  runtime_ref: string
  host_profile_ref: string
  host_client_ref: string
  credential_ref: string
  key_epoch: number
  sender_role: 'host' | 'controller'
  allowed_directions: Array<'request' | 'response' | 'snapshot' | 'event' | 'pairing_claim' | 'pairing_confirm'>
  scope: string[]
  subject_revisions: Record<string, number>
  cnf: {
    key_fingerprint: string
    public_key: string
  }
}

export interface DshRemoteChannelAuthorization {
  authorizationRef: string
  remoteAuthEpoch: number
  serviceLeaseGeneration: number
  expiresAtMillis: number
}

export interface DshRemoteTrustedEventMetadata {
  senderRole: 'host' | 'controller'
  senderCredentialRef: string
  authorizationRef: string
  subjectRevision: number
  remoteAuthEpoch: number
  acceptedAtMillis: number
  targetHostLeaseGeneration: number
}

export interface DshRemoteCipherEnvelope {
  protocol: typeof DSH_REMOTE_PROTOCOL
  protocol_major: typeof DSH_REMOTE_PROTOCOL_MAJOR
  key_epoch: number
  direction: 'host-to-controller' | 'controller-to-host'
  nonce: string
  ciphertext: string
  aad_hash: string
}

export type DshRemoteRealtimePayload = Record<string, unknown> | DshRemoteCipherEnvelope
export type DshRemotePublishDirection = DshRemoteGrantClaims['allowed_directions'][number]

export interface DshRemoteIssuedGrant {
  grant: string
  grantRef?: string
  channelRef?: string
  expiresAtMillis?: number
}

export interface DshRemoteCreatedPairingAttempt {
  pairing: Record<string, unknown>
  grant: DshRemoteIssuedGrant
}

export interface DshRemoteConfirmedPairing {
  pairing: Record<string, unknown>
  binding: DshRemoteBindingProjection
  grant: DshRemoteIssuedGrant
}

export interface DshRemoteControlPlane {
  registerDeviceCredential(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  registerDesktop(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  registerRuntime(desktopRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  updateRuntimePolicy(desktopRef: string, runtimeRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  createPairingAttempt(desktopRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteCreatedPairingAttempt>
  confirmPairing(pairingRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteConfirmedPairing>
  listBindings(signal?: AbortSignal): Promise<DshRemoteBindingProjection[]>
  revokeBinding(bindingRef: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  requestChannelGrant(input: Record<string, unknown>, signal?: AbortSignal): Promise<DshRemoteIssuedGrant>
}

export interface DshRemoteRealtimeTransport {
  subscribeDisconnect(listener: (error: Error) => void): () => void
  connect(input: { profileRef: string; clientRef: string; signal: AbortSignal }): Promise<void>
  disconnect(): Promise<void>
  registerHost(input: {
    runtimeRef: string
    capabilities: DshRemoteCapability[]
    signal: AbortSignal
  }): Promise<{ serviceLeaseGeneration: number }>
  unregisterHost(signal?: AbortSignal): Promise<void>
  authorizeChannel(input: {
    grant: string
    claims: DshRemoteGrantClaims
    signProof: (transcript: string) => Promise<string>
    signal: AbortSignal
  }): Promise<DshRemoteChannelAuthorization>
  subscribe(input: {
    channelRef: string
    authorizationRef: string
    onEvent: (payload: DshRemoteRealtimePayload, metadata: DshRemoteTrustedEventMetadata) => void
    signal: AbortSignal
  }): Promise<() => void>
  publish(input: {
    channelRef: string
    authorizationRef: string
    commandId: string
    direction: DshRemotePublishDirection
    payload: DshRemoteRealtimePayload
    signal: AbortSignal
  }): Promise<{ sequence: number }>
}

export interface DshRemoteWorkspaceView {
  workspaceId: string
  title: string
  path: string
  available: boolean
  sessionIds: string[]
}

export interface DshRemoteSessionSummary {
  sessionId: string
  workspaceId: string
  title?: string
  updatedAt: number
  running: boolean
  blank: boolean
  projectionAsOfSeq?: number
}

export interface DshRemoteSnapshot {
  projectionAsOfMillis: number
  workspaces: DshRemoteWorkspaceView[]
  sessions: DshRemoteSessionSummary[]
  pendingInteractions: DshRemotePendingInteraction[]
  nextCursor?: string
}

export type DshRemotePendingInteraction =
  | {
      kind: 'question'
      interactionRpcRef: string
      sessionId: string
      questions: unknown[]
    }
  | {
      kind: 'approval'
      interactionRpcRef: string
      sessionId: string
      approvalId: string
      toolName: string
      reason?: string
      canAllowOnce: boolean
      operationSummary?: string
    }

export interface DshRemoteHostFacade {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): DshRemoteStatus
  setEnabled(enabled: boolean): Promise<DshRemoteStatus>
  createPairingAttempt(): Promise<DshRemotePairingTicket>
  cancelPairingAttempt(pairingRef: string): Promise<void>
  listBindings(): Promise<DshRemoteBindingProjection[]>
  revokeBinding(bindingRef: string): Promise<void>
  renameDesktop(displayName: string): Promise<DshRemoteStatus>
  subscribe(listener: (status: DshRemoteStatus) => void): () => void
}
