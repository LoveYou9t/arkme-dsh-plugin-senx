export type DshRemoteErrorCode =
  | 'REMOTE_LOGIN_REQUIRED'
  | 'PAIRING_EXPIRED'
  | 'PAIRING_ACCOUNT_MISMATCH'
  | 'PAIRING_ALREADY_CLAIMED'
  | 'PAIRING_CHANNEL_CONFLICT'
  | 'PAIRING_LOCATOR_CONFLICT'
  | 'PAIRING_HOST_CONFIRM_TIMEOUT'
  | 'PAIRING_KEY_CONFIRM_FAILED'
  | 'PAIRING_RATE_LIMITED'
  | 'DEVICE_CREDENTIAL_REVOKED'
  | 'DEVICE_PROOF_INVALID'
  | 'RUNTIME_OFFLINE'
  | 'RUNTIME_LIMIT_REACHED'
  | 'HOST_CHANNEL_NOT_READY'
  | 'REMOTE_DISABLED'
  | 'BINDING_REVOKED'
  | 'REVOCATION_PROPAGATING'
  | 'CHANNEL_GRANT_EXPIRED'
  | 'REMOTE_AUTH_EPOCH_STALE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'WORKSPACE_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'COMMAND_DUPLICATE'
  | 'COMMAND_EXPIRED'
  | 'COMMAND_OUTCOME_UNKNOWN'
  | 'INTERACTION_RESOLVED'
  | 'CONNECTION_REPLACED'
  | 'HOST_GENERATION_STALE'
  | 'SESSION_STATE_CHANGED'
  | 'REPLAY_GAP'
  | 'REMOTE_PROTOCOL_UNSUPPORTED'
  | 'REMOTE_REQUEST_INVALID'
  | 'REMOTE_INVALID_RESPONSE'
  | 'REMOTE_NETWORK_UNAVAILABLE'
  | 'REMOTE_STORAGE_FAILED'
  | 'REMOTE_TRANSPORT_FAILED'

export class DshRemoteError extends Error {
  constructor(
    readonly code: DshRemoteErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DshRemoteError'
  }
}

export function asDshRemoteError(error: unknown): DshRemoteError {
  if (error instanceof DshRemoteError) return error
  return new DshRemoteError(
    'REMOTE_TRANSPORT_FAILED',
    error instanceof Error && error.message.trim() !== '' ? error.message : '远程连接暂时不可用',
    true,
    {},
    { cause: error },
  )
}
