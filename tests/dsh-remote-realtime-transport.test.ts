import { describe, expect, it } from 'vitest'
import {
  ArkmeRemoteRealtimeTransport,
  dshRemoteFrameByteLengths,
  type DshRemoteSocketLike,
} from '../src/dsh-remote/realtime-transport.js'
import { encryptDshRemotePayload } from '../src/dsh-remote/protocol-v1.js'
import type { DshRemoteGrantClaims } from '../src/dsh-remote/types.js'

class FakeSocket implements DshRemoteSocketLike {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()

  open(): void { this.readyState = 1; this.emit('open', {}) }
  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as Record<string, unknown>
    const requestId = frame.request_id
    if (frame.type === 'connection.open') this.reply({ type: 'connection.ready', connection_generation: 11 })
    else if (frame.type === 'channel.authorize.start') this.reply({
      type: 'channel.authorize.challenge', request_id: requestId,
      authorization_ref: 'authorization-test-01', nonce: 'n'.repeat(43), expires_at: 120_000,
    })
    else if (frame.type === 'channel.authorize.prove') this.reply({
      type: 'channel.authorized', request_id: requestId,
      authorization_ref: 'authorization-test-01', sender_role: 'host', remote_auth_epoch: 2, expires_at: 120_000,
      fence_revisions: { credential: 1, binding: 1, runtime: 1, global: 1 },
    })
    else if (frame.type === 'channel.subscribe') this.reply({
      type: 'channel.subscribed', request_id: requestId, namespace: 'dsh_remote',
      channel_ref: frame.channel_ref, authorization_ref: frame.authorization_ref, seq: 1,
    })
    else if (frame.type === 'channel.publish') this.reply({
      type: 'channel.published', request_id: requestId, namespace: 'dsh_remote', channel_ref: frame.channel_ref,
      authorization_ref: frame.authorization_ref, seq: 1,
    })
  }
  remoteEvent(payload: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify({
      type: 'channel.event', namespace: 'dsh_remote', channel_ref: claims.channel_ref, seq: 2,
      event: {
        channel_ref: claims.channel_ref, command_id: 'command-controller-01', seq: 2,
        sender_role: 'controller', sender_credential_ref: claims.credential_ref,
        authorization_ref: 'authorization-controller-01', subject_revision: 1,
        remote_auth_epoch: 2, accepted_at: 1_000, target_host_lease_generation: 11,
        payload, created_at: 1_000,
      },
    }) })
  }
  close(): void { this.readyState = 3 }
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  private reply(frame: Record<string, unknown>): void { queueMicrotask(() => { this.emit('message', { data: JSON.stringify(frame) }) }) }
  private emit(type: string, event: { data?: unknown }): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
}

const claims: DshRemoteGrantClaims = {
  iss: 'jotmo-backend/dsh-remote', aud: 'jotmo-realtime/remote-channel', sub: 'binding-test-01',
  jti: 'grant-test-01', iat: 1, nbf: 1, exp: 121, user_id: 1, client_id: 2,
  grant_kind: 'control', channel_ref: 'channel-test-01', runtime_ref: 'runtime-test-01',
  host_profile_ref: 'profile-test', host_client_ref: 'host-client-test', credential_ref: 'credential-test-01',
  key_epoch: 1, sender_role: 'host', allowed_directions: ['response'], scope: ['session.read'],
  subject_revisions: { credential: 1, binding: 1, runtime: 1, global: 1 },
  cnf: { key_fingerprint: 'f'.repeat(43), public_key: 'p'.repeat(43) },
}

describe('Realtime remote transport wire', () => {
  it('sends the frozen channel_ref in authorize.start and does not depend on it in authorized', async () => {
    const socket = new FakeSocket()
    const transport = new ArkmeRemoteRealtimeTransport(() => socket)
    const controller = new AbortController()
    const connected = transport.connect({ profileRef: 'profile-test', clientRef: 'host-client-test', signal: controller.signal })
    setTimeout(() => { socket.open() }, 0)
    await connected
    await transport.authorizeChannel({ grant: 'g'.repeat(80), claims, signProof: async () => 's'.repeat(86), signal: controller.signal })
    const start = socket.sent.map(value => JSON.parse(value) as Record<string, unknown>)
      .find(frame => frame.type === 'channel.authorize.start')
    expect(start).toMatchObject({ grant: 'g'.repeat(80), channel_ref: 'channel-test-01' })
  })

  it('enforces 60 KiB on the complete encoded WebSocket frame', async () => {
    const socket = new FakeSocket()
    const transport = new ArkmeRemoteRealtimeTransport(() => socket)
    const controller = new AbortController()
    const connected = transport.connect({ profileRef: 'profile-test', clientRef: 'host-client-test', signal: controller.signal })
    setTimeout(() => { socket.open() }, 0)
    await connected
    await transport.authorizeChannel({ grant: 'g'.repeat(80), claims, signProof: async () => 's'.repeat(86), signal: controller.signal })
    await expect(transport.publish({
      channelRef: claims.channel_ref, authorizationRef: 'authorization-test-01', commandId: 'command-small',
      direction: 'response', payload: { blob: 'x'.repeat(40 * 1024) }, signal: controller.signal,
    })).resolves.toEqual({ sequence: 1 })
    expect(Buffer.byteLength(socket.sent.at(-1)!)).toBeLessThanOrEqual(60 * 1024)
    await expect(transport.publish({
      channelRef: claims.channel_ref, authorizationRef: 'authorization-test-01', commandId: 'command-large',
      direction: 'response', payload: { blob: 'x'.repeat(60 * 1024) }, signal: controller.signal,
    })).rejects.toThrow(/publish\/event frame.*60KiB/)
  })

  it('keeps an encrypted maximum read projection inside both frozen outer frames', () => {
    const response = {
      protocol: 'dsh.remote', protocol_major: 1, kind: 'response', request_ref: 'r'.repeat(128),
      status: 'completed', host_generation: Number.MAX_SAFE_INTEGER, issued_at: Number.MAX_SAFE_INTEGER,
      operation: 'snapshot.get', body: {}, result: { blob: '四'.repeat(13_000) },
    }
    const payload = encryptDshRemotePayload(Buffer.alloc(32, 1), response, {
      keyEpoch: 1, direction: 'host-to-controller', nonce: Buffer.alloc(24, 2),
    })
    const sizes = dshRemoteFrameByteLengths({
      channelRef: 'c'.repeat(128), authorizationRef: 'a'.repeat(128), commandId: `response_${'r'.repeat(128)}`,
      direction: 'response', payload, senderRole: 'host', senderCredentialRef: 'd'.repeat(128),
      subjectRevision: Number.MAX_SAFE_INTEGER, remoteAuthEpoch: Number.MAX_SAFE_INTEGER,
      targetHostLeaseGeneration: Number.MAX_SAFE_INTEGER,
    })
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(40 * 1024)
    expect(sizes.publish).toBeLessThanOrEqual(60 * 1024)
    expect(sizes.event).toBeLessThanOrEqual(60 * 1024)
  })

  it('accepts Realtime channel.event with the frozen outer seq and ACKs it', async () => {
    const socket = new FakeSocket()
    const transport = new ArkmeRemoteRealtimeTransport(() => socket)
    const controller = new AbortController()
    const connected = transport.connect({ profileRef: 'profile-test', clientRef: 'host-client-test', signal: controller.signal })
    setTimeout(() => { socket.open() }, 0)
    await connected
    await transport.authorizeChannel({ grant: 'g'.repeat(80), claims, signProof: async () => 's'.repeat(86), signal: controller.signal })
    const received: Record<string, unknown>[] = []
    await transport.subscribe({
      channelRef: claims.channel_ref, authorizationRef: 'authorization-test-01',
      onEvent: payload => { received.push(payload) }, signal: controller.signal,
    })
    socket.remoteEvent({ ciphertext: 'encrypted' })
    expect(received).toEqual([{ ciphertext: 'encrypted' }])
    expect(socket.sent.map(value => JSON.parse(value) as Record<string, unknown>))
      .toContainEqual(expect.objectContaining({ type: 'channel.ack', request_id: expect.any(String), seq: 2 }))
  })
})
