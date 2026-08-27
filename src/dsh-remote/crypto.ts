import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto'
import { DshRemoteError } from './errors.js'
import type {
  DshRemoteDeviceKeyMaterial,
  DshRemoteGrantClaims,
  DshRemotePairingTranscriptInput,
} from './types.js'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/

export function encodeBase64Url(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url')
}

export function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new DshRemoteError('REMOTE_REQUEST_INVALID', '无效的 base64url 数据')
  return Buffer.from(value, 'base64url')
}

function normalizedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedCanonical)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) sorted[key] = normalizedCanonical(child)
    }
    return sorted
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new DshRemoteError('REMOTE_REQUEST_INVALID', '协议数据不能包含非有限数字')
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedCanonical(value))
}

export function sha256(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function generatePairingCode(random: (size: number) => Buffer = randomBytes): string {
  const entropy = random(5)
  if (entropy.length !== 5) throw new Error('pairing entropy source returned the wrong byte length')
  let accumulator = 0
  let bits = 0
  let result = ''
  for (const byte of entropy) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5 && result.length < 8) {
      bits -= 5
      result += CROCKFORD_ALPHABET[(accumulator >>> bits) & 31]
      accumulator &= (1 << bits) - 1
    }
  }
  return result
}

export function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/-/g, '')
  if (!CODE_PATTERN.test(normalized)) {
    throw new DshRemoteError('REMOTE_REQUEST_INVALID', '配对码必须为 8 位 Crockford Base32')
  }
  return normalized
}

export function pairingLocator(code: string): string {
  return sha256(normalizePairingCode(code)).subarray(0, 5).toString('hex')
}

export function pairingPsk(code: string): Buffer {
  return sha256(normalizePairingCode(code))
}

export function generateEd25519DeviceKey(accountId: string, now = Date.now()): DshRemoteDeviceKeyMaterial {
  if (accountId.trim() === '') throw new DshRemoteError('REMOTE_REQUEST_INVALID', '设备密钥必须绑定账号')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicJwk = publicKey.export({ format: 'jwk' })
  const privateJwk = privateKey.export({ format: 'jwk' })
  if (typeof publicJwk.x !== 'string') throw new Error('Ed25519 public key export did not contain x')
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    accountId,
    publicKey: publicJwk.x,
    keyFingerprint: encodeBase64Url(sha256(decodeBase64Url(publicJwk.x))),
    privateJwk,
    keyEpoch: 1,
    createdAtMillis: now,
  }
}

export function signEd25519(privateJwk: NodeJsonWebKey, value: Uint8Array | string): string {
  return encodeBase64Url(sign(null, Buffer.from(value), createPrivateKey({ key: privateJwk, format: 'jwk' })))
}

export function ed25519PrivateJwkFromSeed(seed: Uint8Array): NodeJsonWebKey {
  if (seed.length !== 32) throw new TypeError('Ed25519 seed must be 32 bytes')
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  return createPrivateKey({ key: Buffer.concat([pkcs8Prefix, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })
    .export({ format: 'jwk' })
}

export function ed25519PublicKeyFromSeed(seed: Uint8Array): string {
  const privateKey = createPrivateKey({
    key: { ...ed25519PrivateJwkFromSeed(seed) },
    format: 'jwk',
  })
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
  if (typeof publicJwk.x !== 'string') throw new Error('Ed25519 public key export did not contain x')
  return publicJwk.x
}

export function verifyEd25519(publicKey: string, value: Uint8Array | string, signature: string): boolean {
  try {
    const publicJwk: NodeJsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: publicKey }
    return verify(
      null,
      Buffer.from(value),
      createPublicKey({ key: publicJwk, format: 'jwk' }),
      decodeBase64Url(signature),
    )
  } catch {
    return false
  }
}

export interface X25519KeyMaterial {
  publicKey: string
  privateJwk: NodeJsonWebKey
}

export function generateX25519Key(): X25519KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const publicJwk = publicKey.export({ format: 'jwk' })
  if (typeof publicJwk.x !== 'string') throw new Error('X25519 public key export did not contain x')
  return { publicKey: publicJwk.x, privateJwk: privateKey.export({ format: 'jwk' }) }
}

export function deriveX25519(privateJwk: NodeJsonWebKey, peerPublicKey: string): Buffer {
  const peerJwk: NodeJsonWebKey = { kty: 'OKP', crv: 'X25519', x: peerPublicKey }
  return diffieHellman({
    privateKey: createPrivateKey({ key: privateJwk, format: 'jwk' }),
    publicKey: createPublicKey({ key: peerJwk, format: 'jwk' }),
  })
}

export function deriveX25519Raw(privateKey: string, ownPublicKey: string, peerPublicKey: string): Buffer {
  return deriveX25519({ kty: 'OKP', crv: 'X25519', d: privateKey, x: ownPublicKey }, peerPublicKey)
}

export function pairingTranscript(input: DshRemotePairingTranscriptInput): string {
  return [
    'dsh.remote/v1',
    `environment=${input.environment}`,
    `pairing_ref=${input.pairingRef}`,
    `challenge=${input.challenge}`,
    `claim_nonce=${input.claimNonce}`,
    `host_fingerprint=${input.hostFingerprint}`,
    `controller_fingerprint=${input.controllerFingerprint}`,
  ].join('\n')
}

export function pairingKeyConfirmation(confirmationKey: Uint8Array, transcript: string, role: 'host' | 'controller'): string {
  return encodeBase64Url(createHmac('sha256', confirmationKey).update(`${transcript}\nrole=${role}`).digest())
}

export function verifyPairingKeyConfirmation(
  confirmationKey: Uint8Array,
  transcript: string,
  role: 'host' | 'controller',
  confirmation: string,
): boolean {
  const expected = decodeBase64Url(pairingKeyConfirmation(confirmationKey, transcript, role))
  const actual = decodeBase64Url(confirmation)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export interface DshRemoteDirectionalKeys {
  hostToController: Buffer
  controllerToHost: Buffer
  confirmation: Buffer
}

export function deriveDirectionalKeys(
  sharedSecret: Uint8Array,
  psk: Uint8Array,
  transcript: string,
): DshRemoteDirectionalKeys {
  const salt = sha256(transcript)
  const inputKeyMaterial = Buffer.concat([Buffer.from(sharedSecret), Buffer.from(psk)])
  return {
    hostToController: Buffer.from(hkdfSync('sha256', inputKeyMaterial, salt, 'dsh.remote/v1/host-to-controller', 32)),
    controllerToHost: Buffer.from(hkdfSync('sha256', inputKeyMaterial, salt, 'dsh.remote/v1/controller-to-host', 32)),
    confirmation: Buffer.from(hkdfSync('sha256', inputKeyMaterial, salt, 'dsh.remote/v1/key-confirmation', 32)),
  }
}

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0
  state[d] = rotateLeft(state[d]! ^ state[a]!, 16)
  state[c] = (state[c]! + state[d]!) >>> 0
  state[b] = rotateLeft(state[b]! ^ state[c]!, 12)
  state[a] = (state[a]! + state[b]!) >>> 0
  state[d] = rotateLeft(state[d]! ^ state[a]!, 8)
  state[c] = (state[c]! + state[d]!) >>> 0
  state[b] = rotateLeft(state[b]! ^ state[c]!, 7)
}

export function hChaCha20(key: Uint8Array, nonce: Uint8Array): Buffer {
  if (key.length !== 32 || nonce.length !== 16) throw new TypeError('HChaCha20 requires a 32-byte key and 16-byte nonce')
  const state = new Uint32Array(16)
  const constants = Buffer.from('expand 32-byte k', 'ascii')
  for (let index = 0; index < 4; index += 1) state[index] = constants.readUInt32LE(index * 4)
  const keyBuffer = Buffer.from(key)
  const nonceBuffer = Buffer.from(nonce)
  for (let index = 0; index < 8; index += 1) state[index + 4] = keyBuffer.readUInt32LE(index * 4)
  for (let index = 0; index < 4; index += 1) state[index + 12] = nonceBuffer.readUInt32LE(index * 4)
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12)
    quarterRound(state, 1, 5, 9, 13)
    quarterRound(state, 2, 6, 10, 14)
    quarterRound(state, 3, 7, 11, 15)
    quarterRound(state, 0, 5, 10, 15)
    quarterRound(state, 1, 6, 11, 12)
    quarterRound(state, 2, 7, 8, 13)
    quarterRound(state, 3, 4, 9, 14)
  }
  const result = Buffer.allocUnsafe(32)
  for (const [outputIndex, stateIndex] of [0, 1, 2, 3, 12, 13, 14, 15].entries()) {
    result.writeUInt32LE(state[stateIndex]!, outputIndex * 4)
  }
  return result
}

export interface XChaChaCiphertext {
  nonce: string
  ciphertext: string
}

export function encryptXChaCha20Poly1305(
  key: Uint8Array,
  plaintext: Uint8Array | string,
  aad: Uint8Array | string,
  nonce: Uint8Array = randomBytes(24),
): XChaChaCiphertext {
  if (key.length !== 32 || nonce.length !== 24) throw new TypeError('XChaCha20-Poly1305 requires a 32-byte key and 24-byte nonce')
  const subkey = hChaCha20(key, nonce.subarray(0, 16))
  const chachaNonce = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce.subarray(16))])
  const cipher = createCipheriv('chacha20-poly1305', subkey, chachaNonce, { authTagLength: 16 })
  const encodedPlaintext = Buffer.from(plaintext)
  cipher.setAAD(Buffer.from(aad), { plaintextLength: encodedPlaintext.length })
  const encrypted = Buffer.concat([cipher.update(encodedPlaintext), cipher.final(), cipher.getAuthTag()])
  return { nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(encrypted) }
}

export function decryptXChaCha20Poly1305(
  key: Uint8Array,
  input: XChaChaCiphertext,
  aad: Uint8Array | string,
): Buffer {
  const nonce = decodeBase64Url(input.nonce)
  const encoded = decodeBase64Url(input.ciphertext)
  if (key.length !== 32 || nonce.length !== 24 || encoded.length < 16) {
    throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控密文格式无效')
  }
  try {
    const subkey = hChaCha20(key, nonce.subarray(0, 16))
    const chachaNonce = Buffer.concat([Buffer.alloc(4), nonce.subarray(16)])
    const decipher = createDecipheriv('chacha20-poly1305', subkey, chachaNonce, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(aad), { plaintextLength: encoded.length - 16 })
    decipher.setAuthTag(encoded.subarray(encoded.length - 16))
    return Buffer.concat([decipher.update(encoded.subarray(0, encoded.length - 16)), decipher.final()])
  } catch (error) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', '远控密文认证失败', false, {}, { cause: error })
  }
}

export function channelPopTranscript(input: {
  grantJti: string
  channelRef: string
  senderRole: 'host' | 'controller'
  authorizationRef: string
  connectionGeneration: number
  nonce: string
}): string {
  return [
    'dsh-remote-channel-pop-v1', input.grantJti, input.channelRef, input.senderRole,
    input.authorizationRef, String(input.connectionGeneration), input.nonce,
  ].join('\n')
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', `Grant 缺少 ${key}`)
  }
  return value
}

export function verifyRemoteGrant(
  compactJws: string,
  keyRing: Readonly<Record<string, string>>,
  options: { issuer: string; audience: string; nowSeconds?: number; skewSeconds?: number },
): DshRemoteGrantClaims {
  const parts = compactJws.split('.')
  if (parts.length !== 3) throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant 格式无效')
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(decodeBase64Url(parts[0]!).toString('utf8')) as Record<string, unknown>
    claims = JSON.parse(decodeBase64Url(parts[1]!).toString('utf8')) as Record<string, unknown>
  } catch (error) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant JSON 无效', false, {}, { cause: error })
  }
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant 算法不受支持')
  if (Object.keys(header).some(key => !['alg', 'kid', 'typ'].includes(key))) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant header 含未知字段')
  }
  const kid = requiredString(header, 'kid')
  const publicKey = keyRing[kid]
  if (publicKey === undefined || !verifyEd25519(publicKey, `${parts[0]!}.${parts[1]!}`, parts[2]!)) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant 签名无效')
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skew = options.skewSeconds ?? 30
  const nbf = Number(claims.nbf)
  const exp = Number(claims.exp)
  if (!Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) || now + skew < nbf || now - skew >= exp) {
    throw new DshRemoteError('CHANNEL_GRANT_EXPIRED', 'Grant 尚未生效或已经过期', true)
  }
  if (claims.iss !== options.issuer || claims.aud !== options.audience) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant issuer 或 audience 不匹配')
  }
  const cnf = claims.cnf
  if (cnf === null || typeof cnf !== 'object' || Array.isArray(cnf)) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant 缺少设备密钥约束')
  }
  const candidate = claims as unknown as DshRemoteGrantClaims
  const claimKeys = new Set([
    'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'user_id', 'client_id', 'grant_kind', 'channel_ref',
    'runtime_ref', 'host_profile_ref', 'host_client_ref', 'credential_ref', 'key_epoch', 'sender_role',
    'allowed_directions', 'scope', 'subject_revisions', 'cnf',
  ])
  if (Object.keys(claims).some(key => !claimKeys.has(key))) throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant claims 含未知字段')
  for (const key of [
    'sub', 'jti', 'grant_kind', 'channel_ref', 'runtime_ref',
    'host_profile_ref', 'host_client_ref', 'credential_ref', 'sender_role',
  ]) requiredString(claims, key)
  if (!Number.isSafeInteger(candidate.user_id) || candidate.user_id <= 0
    || !Number.isSafeInteger(candidate.client_id) || candidate.client_id <= 0
    || !Number.isSafeInteger(candidate.iat) || !Number.isSafeInteger(candidate.nbf) || !Number.isSafeInteger(candidate.exp)
    || candidate.exp <= candidate.nbf || candidate.exp <= candidate.iat
    || candidate.exp - candidate.iat > 120
    || !Number.isSafeInteger(candidate.key_epoch) || candidate.key_epoch <= 0
    || !Array.isArray(candidate.allowed_directions) || !Array.isArray(candidate.scope)
    || candidate.subject_revisions === null || typeof candidate.subject_revisions !== 'object'
    || typeof candidate.cnf.key_fingerprint !== 'string' || typeof candidate.cnf.public_key !== 'string') {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant claims 不完整')
  }
  const allowedDirections = new Set(['request', 'response', 'snapshot', 'event', 'pairing_claim', 'pairing_confirm'])
  const directions = candidate.allowed_directions
  const scopes = candidate.scope
  const revisions = candidate.subject_revisions
  const revisionKeys = Object.keys(revisions)
  if (!['pairing', 'control'].includes(candidate.grant_kind) || !['host', 'controller'].includes(candidate.sender_role)
    || directions.length === 0 || new Set(directions).size !== directions.length
    || directions.some(value => typeof value !== 'string' || !allowedDirections.has(value))
    || new Set(scopes).size !== scopes.length || scopes.some(value => typeof value !== 'string' || value.length > 64)
    || revisionKeys.some(key => !['credential', 'binding', 'runtime', 'pairing', 'global'].includes(key))
    || !['credential', 'runtime', 'global'].every(key => Number.isSafeInteger(revisions[key]) && revisions[key]! > 0)
    || candidate.grant_kind === 'pairing' && (!Number.isSafeInteger(revisions.pairing) || revisions.pairing! <= 0 || revisions.binding !== undefined)
    || candidate.grant_kind === 'control' && (!Number.isSafeInteger(revisions.binding) || revisions.binding! <= 0 || revisions.pairing !== undefined)
    || Object.keys(candidate.cnf).some(key => !['key_fingerprint', 'public_key'].includes(key))
    || !/^[A-Za-z0-9_-]{43}$/.test(candidate.cnf.public_key)
    || decodeBase64Url(candidate.cnf.public_key).length !== 32
    || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate.cnf.key_fingerprint)) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant claims 不符合 canonical schema')
  }
  const fingerprint = encodeBase64Url(sha256(decodeBase64Url(candidate.cnf.public_key)))
  if (fingerprint !== candidate.cnf.key_fingerprint) {
    throw new DshRemoteError('DEVICE_PROOF_INVALID', 'Grant 设备密钥指纹不匹配')
  }
  return candidate
}
