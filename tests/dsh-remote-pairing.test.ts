import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, generateEd25519DeviceKey, verifyEd25519 } from '../src/dsh-remote/crypto.js'
import { DshRemotePairingCoordinator } from '../src/dsh-remote/pairing.js'
import type { DshRemoteControlPlane } from '../src/dsh-remote/types.js'

describe('DSH remote Host pairing ticket', () => {
  it('keeps the ticket hidden until Host authorize+subscribe and pins the Host public key in QR', async () => {
    const identity = generateEd25519DeviceKey('42', 1)
    const createPairingAttempt = vi.fn(async (_desktopRef: string, input: Record<string, unknown>) => ({
      pairing: {
        pairing_ref: 'pairing-test-01', pairing_channel_ref: input.pairing_channel_ref,
        challenge: input.challenge, expires_at: 601_000,
      },
      grant: { grant: 'g'.repeat(80), channelRef: String(input.pairing_channel_ref), expiresAtMillis: 121_000 },
    }))
    const coordinator = new DshRemotePairingCoordinator({ createPairingAttempt } as unknown as DshRemoteControlPlane, 'test', () => 1_000)
    const prepared = await coordinator.create({
      desktopRef: 'desktop-test-01', runtimeRef: 'runtime-test-01', identity, userId: 42, clientId: 9,
    })
    const request = createPairingAttempt.mock.calls[0]![1]
    expect(request.code_locator).toMatch(/^[a-f0-9]{10}$/)
    expect(request).not.toHaveProperty('code_locator_hash')
    expect(coordinator.currentTicket()).toBeUndefined()

    const ticket = coordinator.activate(prepared.ticket.pairingRef)
    const qr = JSON.parse(ticket.qrPayload) as Record<string, unknown>
    expect(qr.host_public_signing_key).toBe(identity.publicKey)
    expect(qr.host_fingerprint).toBe(identity.keyFingerprint)
    const unsigned = { ...qr }
    delete unsigned.host_signature
    expect(verifyEd25519(identity.publicKey, canonicalJson(unsigned), String(qr.host_signature))).toBe(true)
    expect(coordinator.currentTicket()).toMatchObject({ pairingRef: 'pairing-test-01' })
  })
})
