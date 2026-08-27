import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  channelPopTranscript,
  decodeBase64Url,
  deriveDirectionalKeys,
  deriveX25519Raw,
  ed25519PrivateJwkFromSeed,
  encryptXChaCha20Poly1305,
  normalizePairingCode,
  pairingKeyConfirmation,
  pairingLocator,
  pairingPsk,
  pairingTranscript,
  signEd25519,
  verifyEd25519,
  verifyRemoteGrant,
} from '../src/dsh-remote/crypto.js'

interface Fixture {
  version: number
  manual_code: { display: string; normalized: string; locator_hex: string }
  key_agreement: Record<string, string>
  grant: Record<string, string | number>
  payload: Record<string, string>
  pairing_ticket: Record<string, string>
}

async function fixture(): Promise<{ raw: Buffer; value: Fixture }> {
  const raw = await readFile(new URL('./fixtures/dsh-remote/protocol-v1.json', import.meta.url))
  return { raw, value: JSON.parse(raw.toString('utf8')) as Fixture }
}

describe('canonical dsh.remote/v1 cross-language fixture', () => {
  it('pins the exact governance checksum', async () => {
    const { raw } = await fixture()
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe('9b1f39baeefd7e59d81a34ae22e69b1055628b7893ec717308f9b81566137b2c')
  })

  it('matches every checksum in the canonical manifest', async () => {
    const root = new URL('./fixtures/dsh-remote/', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as {
      contract: string
      files: Record<string, string>
    }
    expect(manifest.contract).toBe('dsh.remote/v1')
    for (const [path, checksum] of Object.entries(manifest.files)) {
      const localPath = path === 'fixtures/protocol-v1.json' ? 'protocol-v1.json' : path
      const bytes = await readFile(new URL(localPath, root))
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(checksum)
    }
  })

  it('matches manual-code, X25519, HKDF and confirmation bytes', async () => {
    const value = (await fixture()).value
    expect(normalizePairingCode(value.manual_code.display)).toBe(value.manual_code.normalized)
    expect(pairingLocator(value.manual_code.display)).toBe(value.manual_code.locator_hex)
    const agreement = value.key_agreement
    const transcript = pairingTranscript({
      environment: 'test', pairingRef: 'pair_fixture_01', challenge: 'challenge_fixture_01', claimNonce: 'claim_fixture_01',
      hostFingerprint: 'host_fixture_01', controllerFingerprint: 'controller_fixture_01',
    })
    expect(transcript).toBe(agreement.transcript)
    const shared = deriveX25519Raw(agreement.host_private_key, agreement.host_public_key, agreement.controller_public_key)
    expect(shared.toString('base64url')).toBe(agreement.shared_secret)
    const keys = deriveDirectionalKeys(shared, pairingPsk(value.manual_code.normalized), transcript)
    expect(keys.controllerToHost.toString('base64url')).toBe(agreement.controller_to_host_key)
    expect(keys.hostToController.toString('base64url')).toBe(agreement.host_to_controller_key)
    expect(keys.confirmation.toString('base64url')).toBe(agreement.confirmation_key)
    expect(pairingKeyConfirmation(keys.confirmation, transcript, 'controller')).toBe(agreement.controller_confirmation)
    expect(pairingKeyConfirmation(keys.confirmation, transcript, 'host')).toBe(agreement.host_confirmation)
  })

  it('separates Backend Grant signing key from device PoP key', async () => {
    const grant = (await fixture()).value.grant
    const claims = verifyRemoteGrant(String(grant.compact_jws), { 'remote-test-2026-08': String(grant.public_key) }, {
      issuer: 'jotmo-backend/dsh-remote', audience: 'jotmo-realtime/remote-channel', nowSeconds: 1787760000,
    })
    expect(claims.user_id).toBe(1001)
    expect(claims.allowed_directions).toEqual(['request'])
    expect(claims.cnf.public_key).toBe(grant.device_public_key)
    const proof = channelPopTranscript({
      grantJti: claims.jti, channelRef: claims.channel_ref, senderRole: claims.sender_role,
      authorizationRef: String(grant.authorization_ref), connectionGeneration: Number(grant.connection_generation),
      nonce: String(grant.authorization_nonce),
    })
    expect(proof).toBe(grant.proof_transcript)
    expect(signEd25519(ed25519PrivateJwkFromSeed(decodeBase64Url(String(grant.device_private_seed))), proof))
      .toBe(grant.proof_signature)
    expect(verifyEd25519(String(grant.device_public_key), proof, String(grant.proof_signature))).toBe(true)
    expect(verifyEd25519(String(grant.public_key), proof, String(grant.proof_signature))).toBe(false)
  })

  it('pins the QR Host public key by fingerprint before verifying its signature', async () => {
    const ticket = (await fixture()).value.pairing_ticket
    expect(decodeBase64Url(ticket.host_public_signing_key)).toHaveLength(32)
    expect(Buffer.from(createHash('sha256').update(decodeBase64Url(ticket.host_public_signing_key)).digest()).toString('base64url'))
      .toBe(ticket.host_fingerprint)
    expect(signEd25519(
      ed25519PrivateJwkFromSeed(decodeBase64Url(ticket.host_private_seed)),
      ticket.unsigned_canonical_json,
    )).toBe(ticket.host_signature)
    expect(verifyEd25519(ticket.host_public_signing_key, ticket.unsigned_canonical_json, ticket.host_signature)).toBe(true)
  })

  it('matches XChaCha20-Poly1305 ciphertext and tag exactly', async () => {
    const value = (await fixture()).value
    const encrypted = encryptXChaCha20Poly1305(
      decodeBase64Url(value.key_agreement.controller_to_host_key),
      value.payload.plaintext,
      decodeBase64Url(value.payload.aad),
      decodeBase64Url(value.payload.nonce),
    )
    expect(encrypted.ciphertext).toBe(value.payload.ciphertext_and_tag)
  })
})
