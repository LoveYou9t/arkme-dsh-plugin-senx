import WebSocket from 'ws'
import { DSH_REMOTE_MAX_FRAME_BYTES } from './types.js'
import type { DshRemoteSocketLike } from './realtime-transport.js'

export function dshRemoteRealtimeEndpoint(authBaseUrl: string): string {
  const endpoint = new URL(authBaseUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new TypeError('DSH remote Realtime requires a credential-free HTTPS auth origin')
  }
  endpoint.protocol = 'wss:'
  endpoint.pathname = '/api/v1/realtime/connect'
  return endpoint.toString()
}

export function createDefaultDshRemoteSocket(input: {
  authBaseUrl: string
  accessToken: string
  signal: AbortSignal
}): DshRemoteSocketLike {
  const accessToken = input.accessToken.trim()
  if (accessToken === '') throw new TypeError('DSH remote Realtime access token is required')
  if (input.signal.aborted) throw input.signal.reason
  const socket = new WebSocket(dshRemoteRealtimeEndpoint(input.authBaseUrl), {
    headers: { Authorization: `Bearer ${accessToken}` },
    handshakeTimeout: 10_000,
    maxPayload: DSH_REMOTE_MAX_FRAME_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  })
  const closeOnAbort = () => { socket.close(1000, 'aborted') }
  input.signal.addEventListener('abort', closeOnAbort, { once: true })
  socket.addEventListener('close', () => {
    input.signal.removeEventListener('abort', closeOnAbort)
  }, { once: true })
  return socket as unknown as DshRemoteSocketLike
}
