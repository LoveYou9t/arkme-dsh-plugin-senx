import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { securePrivateDirectory, securePrivateFile } from '../private-filesystem.js'
import { DshRemoteError } from './errors.js'
import type { DshRemoteBindingProjection, DshRemoteCapability, DshRemoteRuntimeProjection } from './types.js'

const MAX_RUNTIMES_PER_ACCOUNT = 16

interface AccountRuntimeState {
  displayName?: string
  desktopRef?: string
  credentialRef?: string
  runtimes: Record<string, DshRemoteRuntimeProjection>
  bindings: Record<string, DshRemoteBindingProjection>
}

interface PersistedRuntimeState {
  schemaVersion: 1
  accounts: Record<string, AccountRuntimeState>
}

function emptyState(): PersistedRuntimeState {
  return { schemaVersion: 1, accounts: {} }
}

function accountState(state: PersistedRuntimeState, accountId: string): AccountRuntimeState {
  return state.accounts[accountId] ?? { runtimes: {}, bindings: {} }
}

export class DshRemoteRuntimeStore {
  private readonly path: string
  private state: PersistedRuntimeState | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.path = join(directory, 'dsh-remote', 'runtime-state.json')
  }

  async activateRuntime(input: {
    accountId: string
    profileRef: string
    capabilities: DshRemoteCapability[]
    nowMillis?: number
  }): Promise<DshRemoteRuntimeProjection> {
    let result!: DshRemoteRuntimeProjection
    await this.update(state => {
      const account = accountState(state, input.accountId)
      const current = account.runtimes[input.profileRef]
      if (current === undefined && Object.keys(account.runtimes).length >= MAX_RUNTIMES_PER_ACCOUNT) {
        throw new DshRemoteError('RUNTIME_LIMIT_REACHED', '同一桌面账号最多注册 16 个 DSH Runtime')
      }
      result = {
        runtimeRef: current?.runtimeRef ?? `runtime_${randomUUID()}`,
        ...(account.desktopRef === undefined ? {} : { desktopRef: account.desktopRef }),
        profileRef: input.profileRef,
        accountId: input.accountId,
        remoteEnabled: current?.remoteEnabled ?? false,
        hostGeneration: (current?.hostGeneration ?? 0) + 1,
        capabilities: [...new Set(input.capabilities)].sort(),
        updatedAtMillis: input.nowMillis ?? Date.now(),
      }
      account.runtimes[input.profileRef] = result
      state.accounts[input.accountId] = account
    })
    return result
  }

  async setRemoteEnabled(accountId: string, profileRef: string, enabled: boolean): Promise<DshRemoteRuntimeProjection> {
    let result!: DshRemoteRuntimeProjection
    await this.update(state => {
      const account = accountState(state, accountId)
      const runtime = account.runtimes[profileRef]
      if (runtime === undefined) throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控 Runtime 尚未注册')
      result = { ...runtime, remoteEnabled: enabled, updatedAtMillis: Date.now() }
      account.runtimes[profileRef] = result
      state.accounts[accountId] = account
    })
    return result
  }

  async adoptRuntimeRef(accountId: string, profileRef: string, runtimeRef: string): Promise<DshRemoteRuntimeProjection> {
    const normalized = runtimeRef.trim()
    if (!/^[A-Za-z0-9._:-]{8,256}$/.test(normalized)) throw new DshRemoteError('REMOTE_STORAGE_FAILED', 'Backend Runtime 引用无效')
    let result!: DshRemoteRuntimeProjection
    await this.update(state => {
      const account = accountState(state, accountId)
      const runtime = account.runtimes[profileRef]
      if (runtime === undefined) throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控 Runtime 尚未注册')
      const collision = Object.entries(account.runtimes).some(([otherProfile, other]) => otherProfile !== profileRef && other.runtimeRef === normalized)
      if (collision) throw new DshRemoteError('REMOTE_STORAGE_FAILED', 'Backend Runtime 引用与其他 Profile 冲突')
      result = { ...runtime, runtimeRef: normalized, updatedAtMillis: Date.now() }
      account.runtimes[profileRef] = result
      state.accounts[accountId] = account
    })
    return result
  }

  async bindDesktop(accountId: string, input: { desktopRef: string; credentialRef: string }): Promise<void> {
    await this.update(state => {
      const account = accountState(state, accountId)
      account.desktopRef = input.desktopRef
      account.credentialRef = input.credentialRef
      for (const [profileRef, runtime] of Object.entries(account.runtimes)) {
        account.runtimes[profileRef] = { ...runtime, desktopRef: input.desktopRef }
      }
      state.accounts[accountId] = account
    })
  }

  async renameDesktop(accountId: string, displayName: string): Promise<void> {
    const normalized = displayName.trim()
    if (normalized === '' || [...normalized].length > 80) throw new DshRemoteError('REMOTE_REQUEST_INVALID', '电脑名称必须为 1 至 80 个字符')
    await this.update(state => {
      const account = accountState(state, accountId)
      account.displayName = normalized
      state.accounts[accountId] = account
    })
  }

  async upsertBindings(accountId: string, bindings: DshRemoteBindingProjection[]): Promise<void> {
    await this.update(state => {
      const account = accountState(state, accountId)
      account.bindings = Object.fromEntries(bindings.map(binding => [binding.bindingRef, { ...binding }]))
      state.accounts[accountId] = account
    })
  }

  async account(accountId: string): Promise<{
    displayName?: string
    desktopRef?: string
    credentialRef?: string
    runtimes: DshRemoteRuntimeProjection[]
    bindings: DshRemoteBindingProjection[]
  }> {
    return await this.read(state => {
      const account = accountState(state, accountId)
      return {
        ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
        ...(account.desktopRef === undefined ? {} : { desktopRef: account.desktopRef }),
        ...(account.credentialRef === undefined ? {} : { credentialRef: account.credentialRef }),
        runtimes: Object.values(account.runtimes).map(runtime => ({ ...runtime })),
        bindings: Object.values(account.bindings).map(binding => ({ ...binding })),
      }
    })
  }

  private async read<T>(reader: (state: PersistedRuntimeState) => T): Promise<T> {
    let result!: T
    await this.serial(async () => { result = reader(await this.load()) })
    return result
  }

  private async update(mutator: (state: PersistedRuntimeState) => void): Promise<void> {
    await this.serial(async () => {
      const state = await this.load()
      mutator(state)
      await this.persist(state)
    })
  }

  private async serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    await next
  }

  private async load(): Promise<PersistedRuntimeState> {
    if (this.state !== undefined) return this.state
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as PersistedRuntimeState
      if (parsed.schemaVersion !== 1 || parsed.accounts === null || typeof parsed.accounts !== 'object') throw new Error('schema mismatch')
      this.state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new DshRemoteError('REMOTE_STORAGE_FAILED', '远控 Runtime 状态已损坏', false, {}, { cause: error })
      }
      this.state = emptyState()
      await this.persist(this.state)
    }
    return this.state
  }

  private async persist(state: PersistedRuntimeState): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await securePrivateDirectory(directory)
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
    await securePrivateFile(temporary)
    await rename(temporary, this.path)
    await securePrivateFile(this.path)
    this.state = state
  }
}
