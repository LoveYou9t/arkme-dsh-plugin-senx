import { createHash, randomBytes } from 'node:crypto'
import type { ArkmeSecureValueStore } from '../keychain-store.js'
import { decodeBase64Url, encodeBase64Url, generateEd25519DeviceKey } from './crypto.js'
import { DshRemoteError } from './errors.js'
import type { DshRemoteDeviceKeyMaterial } from './types.js'

interface PersistedDesktopSecrets {
  schemaVersion: 1
  accountId: string
  identity: DshRemoteDeviceKeyMaterial
  ledgerKey: string
}

function accountKey(accountId: string): string {
  const normalized = accountId.trim()
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控账号标识无效')
  }
  return `dsh-remote-desktop:${normalized}`
}

function parseSecrets(raw: string, accountId: string): PersistedDesktopSecrets {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch (error) { throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控设备凭据已损坏', false, {}, { cause: error }) }
  if (value === null || typeof value !== 'object') throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控设备凭据已损坏')
  const source = value as Partial<PersistedDesktopSecrets>
  if (source.schemaVersion !== 1 || source.accountId !== accountId || source.identity?.accountId !== accountId
    || source.identity.algorithm !== 'Ed25519' || typeof source.identity.publicKey !== 'string'
    || typeof source.identity.keyFingerprint !== 'string' || source.identity.privateJwk === undefined
    || typeof source.ledgerKey !== 'string' || decodeBase64Url(source.ledgerKey).length !== 32) {
    throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控设备凭据合同不兼容')
  }
  return source as PersistedDesktopSecrets
}

/** Installation-level credential broker: the secure service namespace is shared across DSH Profiles. */
export class DesktopCredentialBroker {
  private readonly inFlight = new Map<string, Promise<PersistedDesktopSecrets>>()
  private readonly channelWrites = new Map<string, Promise<void>>()

  constructor(private readonly store: ArkmeSecureValueStore) {}

  async getOrCreate(accountId: string): Promise<DshRemoteDeviceKeyMaterial> {
    return (await this.secrets(accountId)).identity
  }

  async ledgerKey(accountId: string): Promise<Buffer> {
    return decodeBase64Url((await this.secrets(accountId)).ledgerKey)
  }

  async rotate(accountId: string): Promise<DshRemoteDeviceKeyMaterial> {
    const current = await this.secrets(accountId)
    const rotated = {
      ...generateEd25519DeviceKey(accountId),
      keyEpoch: current.identity.keyEpoch + 1,
    }
    const next: PersistedDesktopSecrets = { ...current, identity: rotated }
    await this.store.write(accountKey(accountId), JSON.stringify(next))
    return rotated
  }

  async delete(accountId: string): Promise<void> {
    this.inFlight.delete(accountId)
    await this.store.delete(accountKey(accountId))
  }

  async putChannelKeys(input: {
    accountId: string
    bindingRef: string
    runtimeRef: string
    channelRef: string
    keyEpoch: number
    rootSecret: Uint8Array
    controllerPublicKey: string
    controllerKeyFingerprint: string
    controllerToHost: Uint8Array
    hostToController: Uint8Array
    lastTransportSequence?: number
  }): Promise<void> {
    if (input.rootSecret.length !== 32 || input.controllerToHost.length !== 32 || input.hostToController.length !== 32
      || !/^[A-Za-z0-9_-]{43}$/.test(input.controllerPublicKey) || input.controllerKeyFingerprint.length < 32
      || !Number.isSafeInteger(input.keyEpoch) || input.keyEpoch <= 0) {
      throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控频道密钥无效')
    }
    if (input.lastTransportSequence !== undefined
      && (!Number.isSafeInteger(input.lastTransportSequence) || input.lastTransportSequence < 0)) {
      throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控频道 transport sequence 无效')
    }
    const account = this.channelAccount(input)
    const previous = this.channelWrites.get(account) ?? Promise.resolve()
    const writing = previous.catch(() => undefined).then(async () => {
      // Publish the revocation index before the secret. A crash may leave a
      // harmless missing secret behind the index, never an unindexed key that
      // a later Binding revoke cannot find and purge.
      await this.store.write(this.channelIndexAccount(input), input.channelRef)
      await this.store.write(account, JSON.stringify({
        schemaVersion: 1, accountId: input.accountId, bindingRef: input.bindingRef,
        runtimeRef: input.runtimeRef, channelRef: input.channelRef, keyEpoch: input.keyEpoch,
        rootSecret: encodeBase64Url(input.rootSecret), controllerPublicKey: input.controllerPublicKey,
        controllerKeyFingerprint: input.controllerKeyFingerprint,
        controllerToHost: encodeBase64Url(input.controllerToHost),
        hostToController: encodeBase64Url(input.hostToController),
        ...(input.lastTransportSequence === undefined ? {} : { lastTransportSequence: input.lastTransportSequence }),
      }))
    })
    this.channelWrites.set(account, writing)
    try { await writing }
    finally { if (this.channelWrites.get(account) === writing) this.channelWrites.delete(account) }
  }

  async channelKeys(input: { accountId: string; bindingRef: string; runtimeRef: string; channelRef: string }): Promise<{
    keyEpoch: number
    rootSecret: Buffer
    controllerPublicKey: string
    controllerKeyFingerprint: string
    controllerToHost: Buffer
    hostToController: Buffer
    lastTransportSequence: number
  } | undefined> {
    const account = this.channelAccount(input)
    await this.channelWrites.get(account)?.catch(() => undefined)
    const raw = await this.store.read(account)
    if (raw === undefined) return undefined
    let source: Record<string, unknown>
    try { source = JSON.parse(raw) as Record<string, unknown> }
    catch (error) { throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控频道密钥已损坏', false, {}, { cause: error }) }
    if (source.schemaVersion !== 1 || source.accountId !== input.accountId || source.bindingRef !== input.bindingRef
      || source.runtimeRef !== input.runtimeRef || source.channelRef !== input.channelRef
      || typeof source.keyEpoch !== 'number' || !Number.isSafeInteger(source.keyEpoch) || source.keyEpoch <= 0
      || typeof source.rootSecret !== 'string' || typeof source.controllerPublicKey !== 'string'
      || typeof source.controllerKeyFingerprint !== 'string'
      || typeof source.controllerToHost !== 'string' || typeof source.hostToController !== 'string'
      || (source.lastTransportSequence !== undefined
        && (typeof source.lastTransportSequence !== 'number' || !Number.isSafeInteger(source.lastTransportSequence)
          || source.lastTransportSequence < 0))) {
      throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控频道密钥路由不匹配')
    }
    const rootSecret = decodeBase64Url(source.rootSecret)
    const controllerToHost = decodeBase64Url(source.controllerToHost)
    const hostToController = decodeBase64Url(source.hostToController)
    if (rootSecret.length !== 32 || controllerToHost.length !== 32 || hostToController.length !== 32) throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控频道密钥长度无效')
    return {
      keyEpoch: source.keyEpoch, rootSecret, controllerPublicKey: source.controllerPublicKey,
      controllerKeyFingerprint: source.controllerKeyFingerprint, controllerToHost, hostToController,
      lastTransportSequence: typeof source.lastTransportSequence === 'number' ? source.lastTransportSequence : 0,
    }
  }

  async deleteChannelKeys(input: { accountId: string; bindingRef: string; runtimeRef: string; channelRef: string }): Promise<void> {
    const account = this.channelAccount(input)
    await this.channelWrites.get(account)?.catch(() => undefined)
    await this.store.delete(account)
    await this.store.delete(this.channelIndexAccount(input))
  }

  async deleteBindingChannelKeys(input: { accountId: string; bindingRef: string; runtimeRef: string }): Promise<void> {
    const indexAccount = this.channelIndexAccount(input)
    const channelRef = await this.store.read(indexAccount)
    if (channelRef !== undefined) {
      const account = this.channelAccount({ ...input, channelRef })
      await this.channelWrites.get(account)?.catch(() => undefined)
      await this.store.delete(account)
    }
    await this.store.delete(indexAccount)
  }

  private async secrets(accountId: string): Promise<PersistedDesktopSecrets> {
    const normalized = accountId.trim()
    const existing = this.inFlight.get(normalized)
    if (existing !== undefined) return await existing
    const loading = this.loadOrCreate(normalized)
    this.inFlight.set(normalized, loading)
    try { return await loading }
    catch (error) {
      if (this.inFlight.get(normalized) === loading) this.inFlight.delete(normalized)
      throw error
    }
  }

  private async loadOrCreate(accountId: string): Promise<PersistedDesktopSecrets> {
    const key = accountKey(accountId)
    const raw = await this.store.read(key)
    if (raw !== undefined) return parseSecrets(raw, accountId)
    const created: PersistedDesktopSecrets = {
      schemaVersion: 1,
      accountId,
      identity: generateEd25519DeviceKey(accountId),
      ledgerKey: encodeBase64Url(randomBytes(32)),
    }
    await this.store.write(key, JSON.stringify(created))
    return created
  }

  private channelAccount(input: { accountId: string; bindingRef: string; runtimeRef: string; channelRef: string }): string {
    for (const value of [input.accountId, input.bindingRef, input.runtimeRef, input.channelRef]) {
      if (value.trim() === '' || value.length > 256) throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控频道密钥路由无效')
    }
    const digest = createHash('sha256').update([
      'dsh-remote-channel-key-v1', input.accountId, input.bindingRef, input.runtimeRef, input.channelRef,
    ].join('\n')).digest('base64url')
    return `dsh-remote-channel:${digest}`
  }

  private channelIndexAccount(input: { accountId: string; bindingRef: string; runtimeRef: string }): string {
    for (const value of [input.accountId, input.bindingRef, input.runtimeRef]) {
      if (value.trim() === '' || value.length > 256) throw new DshRemoteError('REMOTE_REQUEST_INVALID', '远控频道密钥索引无效')
    }
    const digest = createHash('sha256').update([
      'dsh-remote-channel-index-v1', input.accountId, input.bindingRef, input.runtimeRef,
    ].join('\n')).digest('base64url')
    return `dsh-remote-channel-index:${digest}`
  }
}
