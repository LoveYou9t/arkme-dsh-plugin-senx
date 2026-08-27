import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  channelPopTranscript,
  decodeBase64Url,
  deriveDirectionalKeys,
  deriveX25519,
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
  generateEd25519DeviceKey,
  generatePairingCode,
  generateX25519Key,
  normalizePairingCode,
  pairingKeyConfirmation,
  pairingLocator,
  pairingPsk,
  pairingTranscript,
  signEd25519,
  verifyEd25519,
  verifyPairingKeyConfirmation,
} from '../src/dsh-remote/crypto.js'

describe('dsh.remote/v1 crypto contract', () => {
  it('generates and normalizes the 100-bit Crockford pairing secret', () => {
    const code = generatePairingCode(size => Buffer.alloc(size, 0xab))
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/)
    expect(normalizePairingCode(`${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10)}`)).toBe(code)
    expect(pairingLocator(code)).toMatch(/^[a-f0-9]{10}$/)
    expect(pairingLocator('0123-4567-89AB-CDEF-GHJK')).toBe('a6b239e799')
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(() => normalizePairingCode(`0123456789ABCDEFGH${ambiguous}K`)).toThrow(/Crockford/)
    }
    expect(() => normalizePairingCode('0123456789 ABCDEFGHJK')).toThrow(/Crockford/)
    expect(() => normalizePairingCode('1234')).toThrow(/20/)
  })

  it('keeps canonical transcripts stable across object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"z":1}')
    const transcript = pairingTranscript({
      environment: 'test', pairingRef: 'pair_1', challenge: 'challenge', claimNonce: 'claim',
      hostFingerprint: 'host', controllerFingerprint: 'controller',
    })
    expect(transcript).toContain('dsh.remote/v1\n')
  })

  it('signs device proofs and derives matching X25519 direction keys', () => {
    const hostIdentity = generateEd25519DeviceKey('42', 1)
    const signature = signEd25519(hostIdentity.privateJwk, 'challenge')
    expect(verifyEd25519(hostIdentity.publicKey, 'challenge', signature)).toBe(true)
    expect(verifyEd25519(hostIdentity.publicKey, 'changed', signature)).toBe(false)

    const host = generateX25519Key()
    const controller = generateX25519Key()
    const hostSecret = deriveX25519(host.privateJwk, controller.publicKey)
    const controllerSecret = deriveX25519(controller.privateJwk, host.publicKey)
    expect(hostSecret).toEqual(controllerSecret)
    const transcript = 'pairing-transcript'
    const psk = pairingPsk('0123456789ABCDEFGHJK')
    const hostKeys = deriveDirectionalKeys(hostSecret, psk, transcript)
    const controllerKeys = deriveDirectionalKeys(controllerSecret, psk, transcript)
    expect(hostKeys).toEqual(controllerKeys)
    expect(hostKeys.hostToController).not.toEqual(hostKeys.controllerToHost)
  })

  it('authenticates pairing key confirmation by role', () => {
    const confirmationKey = Buffer.alloc(32, 4)
    const confirmation = pairingKeyConfirmation(confirmationKey, 'transcript', 'host')
    expect(verifyPairingKeyConfirmation(confirmationKey, 'transcript', 'host', confirmation)).toBe(true)
    expect(verifyPairingKeyConfirmation(confirmationKey, 'transcript', 'controller', confirmation)).toBe(false)
  })

  it('encrypts XChaCha20-Poly1305 with AAD and rejects tampering', () => {
    const key = Buffer.alloc(32, 7)
    const nonce = Buffer.from(Array.from({ length: 24 }, (_value, index) => index))
    const encrypted = encryptXChaCha20Poly1305(key, 'secret prompt', 'metadata', nonce)
    expect(decryptXChaCha20Poly1305(key, encrypted, 'metadata').toString()).toBe('secret prompt')
    const tampered = Buffer.from(decodeBase64Url(encrypted.ciphertext))
    tampered[0] ^= 1
    expect(() => decryptXChaCha20Poly1305(key, { ...encrypted, ciphertext: tampered.toString('base64url') }, 'metadata'))
      .toThrow(/认证失败/)
    expect(() => decryptXChaCha20Poly1305(key, encrypted, 'other')).toThrow(/认证失败/)
  })

  it('locks the Realtime PoP transcript byte-for-byte', () => {
    expect(channelPopTranscript({
      grantJti: 'grant-jti', channelRef: 'channel-ref', senderRole: 'host',
      authorizationRef: 'authorization-ref', connectionGeneration: 9, nonce: 'nonce',
    })).toBe('dsh-remote-channel-pop-v1\ngrant-jti\nchannel-ref\nhost\nauthorization-ref\n9\nnonce')
  })
})
