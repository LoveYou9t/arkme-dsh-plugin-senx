import type { ArkmeBotSummary, ArkmeChatClientEvent, ArkmeConversationDirectoryVisibilityItem, ArkmeSourceItem, ArkmeSourceList } from '../types.js'
import { retainNewerArkmeChatPin } from '../chat-pin-projection.js'
import type { SourceService } from './source-service.js'
import type { ConversationDirectoryVisibilityService } from './conversation-directory-visibility-service.js'
import { ArkmePluginError, type ServiceRuntime } from './service.js'

const PAGE_SIZE = 20
const MAX_ROWS = 20_000
const keyOf = (source: ArkmeSourceItem) => source.sourceKey ?? source.sourceRef

/** Merge pages and live changes without interpreting page absence as removal. */
export function mergeDirectorySource(previous: ArkmeSourceItem | undefined, incoming: ArkmeSourceItem, keepLive = false): ArkmeSourceItem {
  if (previous === undefined) return incoming
  const stale = (incoming.latestSequence ?? 0) < (previous.latestSequence ?? 0)
    || keepLive && (incoming.latestSequence ?? 0) <= (previous.latestSequence ?? 0) && incoming.activeAtMillis <= previous.activeAtMillis
  const merged = { ...previous, ...incoming }
  if (stale) {
    merged.sourceRef = previous.sourceRef
    for (const field of ['latestSequence', 'latestPreview', 'activeAtMillis', 'unreadCount', 'badgeUnreadCount', 'hasUnreadMention'] as const) {
      if (previous[field] !== undefined) Object.assign(merged, { [field]: previous[field] })
    }
  }
  return retainNewerArkmeChatPin(previous, merged)
}

/** One account lifecycle owns cache restoration, a twenty-row scan, and directory deltas. */
export class ConversationDirectoryService {
  private userId: number | undefined
  private generation = 0
  private revision = 0
  private cachedAtMillis = 0
  private visibilityMutations = new Map<string, number>()
  private sources = new Map<string, ArkmeSourceItem>()
  private mutations = new Map<string, number>()
  private visibility = new Map<string, ArkmeConversationDirectoryVisibilityItem>()
  private bots: ArkmeBotSummary[] = []
  private botPinnedKeys = new Set<string>()
  private deletedBotRefs = new Set<string>()
  private special: Pick<NonNullable<ArkmeSourceList['projection']>, 'sendToSelf' | 'arkoProfile' | 'arkoPreview'> = {}
  private phase: NonNullable<ArkmeSourceList['projection']>['phase'] = 'cached'
  private error: string | undefined
  private restore: Promise<void> | undefined
  private scan: Promise<void> | undefined
  private firstPage: Promise<void> | undefined
  private rawBaseline: Promise<ArkmeSourceList> | undefined
  private controller = new AbortController()
  private persistence = Promise.resolve()
  private diskPending: { userId: number; page: ArkmeSourceList } | undefined
  private diskWriting = false
  private cacheFailure: unknown
  private lastPublished = ""
  private avatars = new Map<string, ArkmeSourceItem>()
  private avatarWork: Promise<void> | undefined

  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
    private readonly preferences: ConversationDirectoryVisibilityService,
    private readonly readBots: (signal: AbortSignal) => Promise<{ items: ArkmeBotSummary[] }>,
    private readonly warmAvatar: (ref: string, signal: AbortSignal) => Promise<unknown>,
    private readonly emit: (page: ArkmeSourceList) => void,
  ) {}

  reset(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.generation++
    this.userId = undefined
    this.sources.clear(); this.mutations.clear(); this.visibility.clear(); this.visibilityMutations.clear(); this.avatars.clear()
    this.bots = []; this.botPinnedKeys.clear(); this.deletedBotRefs.clear(); this.special = {}; this.restore = undefined; this.scan = undefined; this.firstPage = undefined; this.rawBaseline = undefined; this.avatarWork = undefined
    this.phase = 'cached'; this.error = undefined; this.lastPublished = ''
  }

  private async activate(): Promise<void> {
    const { userId } = await this.runtime.requireSession()
    if (userId !== this.userId) {
      this.reset(); this.userId = userId
      const generation = this.generation
      this.restore = (async () => {
        const cached = await this.runtime.stateStore.readDirectoryCache?.(userId)
        if (generation !== this.generation || cached === undefined) return
        // References are validated by the current Host before they can reach a consumer.
        if (cached.items[0] !== undefined) await this.source.openSourceRef(cached.items[0].sourceRef, userId)
        if (generation !== this.generation) return
        for (const item of cached.items) this.sources.set(keyOf(item), item)
        this.cachedAtMillis = cached.projection?.cachedAtMillis ?? 0
        for (const item of cached.projection?.visibility ?? []) this.visibility.set(`${item.entryKind}:${item.entryRef}`, item)
        this.bots = cached.projection?.bots ?? []
        this.botPinnedKeys = new Set(cached.projection?.botPinnedKeys ?? [])
        this.special = { ...(cached.projection?.sendToSelf === undefined ? {} : { sendToSelf: cached.projection.sendToSelf }),
          ...(cached.projection?.arkoProfile === undefined ? {} : { arkoProfile: cached.projection.arkoProfile }),
          ...(cached.projection?.arkoPreview === undefined ? {} : { arkoPreview: cached.projection.arkoPreview }) }
        this.revision = Math.max(this.revision, cached.projection?.revision ?? 0)
      })().catch(() => { /* A corrupt derived cache falls back to the authoritative first page. */ })
    }
    await this.restore
  }

  async read(force = false): Promise<ArkmeSourceList> {
    await this.activate()
    const generation = this.generation
    const cached = this.snapshot()
    const hasCache = cached.items.length > 0 || cached.projection!.bots.length > 0
    if (this.scan === undefined && (force || this.phase === 'cached' || this.phase === 'failed')) this.startScan()
    if (hasCache) return cached
    await this.firstPage
    if (generation !== this.generation) throw new ArkmePluginError('login-context-changed', '账号已切换', false, 409)
    return this.snapshot()
  }

  /** Notification callers join the same scan, but only accept a complete current connection baseline. */
  async complete(): Promise<ArkmeSourceList> {
    await this.activate()
    if (this.scan === undefined) this.startScan()
    return await this.rawBaseline!
  }

  async settled(): Promise<void> { await this.scan; await this.avatarWork; await this.persistence }

  private startScan(): void {
    const generation = this.generation
    const userId = this.userId!
    const signal = this.controller.signal
    this.phase = 'loading'; this.error = undefined
    let ready!: () => void
    let failed!: (error: unknown) => void
    this.firstPage = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    let baselineReady!: (page: ArkmeSourceList) => void
    let baselineFailed!: (error: unknown) => void
    this.rawBaseline = new Promise<ArkmeSourceList>((resolve, reject) => { baselineReady = resolve; baselineFailed = reject })
    void this.rawBaseline.catch(() => undefined)
    const rawSources = new Map<string, ArkmeSourceItem>()
    void this.firstPage.catch(() => undefined)
    const pending = (async () => {
      let cursor: string | undefined
      const visited = new Set<string>()
      let first = true
      do {
        signal.throwIfAborted()
        if (visited.size >= MAX_ROWS / PAGE_SIZE) throw new Error("Directory page budget exceeded; synchronization incomplete")
        const atRevision = this.revision
        const page = await this.source.listSources('root', { limit: PAGE_SIZE, refresh: true, firstPaint: true, ...(cursor === undefined ? {} : { cursor }), signal })
        if (generation !== this.generation || (await this.runtime.requireSession()).userId !== userId) throw new DOMException('Account changed', 'AbortError')
        if (page.hasMore && (page.nextCursor === undefined || visited.has(page.nextCursor))) throw new ArkmePluginError('directory-cursor-invalid', '会话目录分页未完成：游标无效', true, 502)
        for (const item of page.items) rawSources.set(keyOf(item), item)
        if (!page.hasMore) baselineReady({ directory: 'root', items: [...rawSources.values()], hasMore: false })
        const visibleCandidates = page.items.map(item => mergeDirectorySource(this.sources.get(keyOf(item)), item, (this.mutations.get(keyOf(item)) ?? 0) > atRevision))
        const visibility = await this.preferences.query(visibleCandidates.map(item => item.sourceRef), [], signal).catch(error => {
          if (signal.aborted || (error instanceof ArkmePluginError && !error.retryable && [401, 403, 409].includes(error.httpStatus))) throw error
          return { items: visibleCandidates.map(item => ({ entryKind: 'source' as const, entryRef: item.sourceRef, hidden: this.visibility.get(`source:${item.sourceRef}`)?.hidden ?? false })) }
        })
        signal.throwIfAborted()
        this.phase = 'syncing'
        this.apply(page.items, visibility.items, atRevision)
        if (first) { first = false; ready() }
        for (const item of page.items) this.avatars.set(keyOf(item), item)
        this.startAvatars(generation)
        if (!page.hasMore) break
        cursor = page.nextCursor!; visited.add(cursor)
        // Yield between pages so first-paint delivery and interactive requests can run.
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
      } while (true)
      // Bot discovery is independent of the ordinary first page.
      const bots = await this.readBots(signal)
      if (generation !== this.generation) return
      const visible = await this.preferences.query([], bots.items.map(item => item.botRef), signal)
      const mergedBots = new Map(this.bots.map(bot => [bot.directoryKey ?? bot.botRef, bot]))
      for (const bot of bots.items) {
        if (!this.deletedBotRefs.has(bot.botRef)) mergedBots.set(bot.directoryKey ?? bot.botRef, bot)
      }
      this.bots = [...mergedBots.values()]
      this.phase = 'complete'
      this.apply([], visible.items)
    })().catch(error => {
      if (generation === this.generation) {
        this.phase = 'failed'; this.error = error instanceof Error ? error.message : '目录同步失败'
        this.publish([])
      }
      failed(error); baselineFailed(error)
      throw error
    }).finally(() => { if (this.scan === pending) this.scan = undefined })
    this.scan = pending
    void pending.catch(() => undefined)
  }

  private apply(items: ArkmeSourceItem[], visibility: ArkmeConversationDirectoryVisibilityItem[] = [], atRevision = this.revision): void {
    const changed: ArkmeSourceItem[] = []
    for (const item of items) {
      const key = keyOf(item)
      const previous = this.sources.get(key)
      const merged = mergeDirectorySource(previous, item, (this.mutations.get(key) ?? 0) > atRevision)
      if (JSON.stringify(previous) === JSON.stringify(merged)) continue
      if (previous === undefined && this.sources.size >= MAX_ROWS) throw new Error('Conversation directory capacity exceeded; scan incomplete')
      if (previous !== undefined && previous.sourceRef !== merged.sourceRef) {
        this.visibility.delete(`source:${previous.sourceRef}`)
        this.visibilityMutations.delete(`source:${previous.sourceRef}`)
      }
      this.sources.set(key, merged); this.mutations.set(key, this.revision + 1); changed.push(merged)
    }
    const acceptedVisibility = visibility.filter(entry => (this.visibilityMutations.get(`${entry.entryKind}:${entry.entryRef}`) ?? 0) <= atRevision)
    for (const entry of acceptedVisibility) {
      const key = `${entry.entryKind}:${entry.entryRef}`
      this.visibility.set(key, entry); this.visibilityMutations.set(key, this.revision + 1)
    }
    this.publish(changed, acceptedVisibility)
  }

  private snapshot(items = [...this.sources.values()], visibility = [...this.visibility.values()]): ArkmeSourceList {
    return { directory: 'root', items, hasMore: this.phase !== 'complete', projection: {
      ...this.special, botPinnedKeys: [...this.botPinnedKeys], revision: this.revision, phase: this.phase, cachedAtMillis: this.cachedAtMillis, visibility, bots: this.bots,
      ...(this.error === undefined ? {} : { error: this.error }),
    } }
  }

  private publish(items: ArkmeSourceItem[], visibility: ArkmeConversationDirectoryVisibilityItem[] = []): void {
    const fingerprint = JSON.stringify({ items, visibility, phase: this.phase, error: this.error, bots: this.bots, special: this.special, pins: [...this.botPinnedKeys] })
    if (fingerprint === this.lastPublished) return
    this.lastPublished = fingerprint
    this.revision++
    this.cachedAtMillis = Date.now()
    const page = this.snapshot(items, visibility)
    const userId = this.userId!
    this.emit(page)
    // The first visible page never waits for disk I/O. Serialize incremental writes in the owner.
    const queued = this.diskPending?.userId === userId ? this.diskPending.page : undefined
    const rows = new Map((queued?.items ?? []).map(item => [keyOf(item), item]))
    for (const item of page.items) rows.set(keyOf(item), item)
    const hidden = new Map((queued?.projection?.visibility ?? []).map(item => [`${item.entryKind}:${item.entryRef}`, item]))
    for (const item of page.projection!.visibility) hidden.set(`${item.entryKind}:${item.entryRef}`, item)
    this.diskPending = { userId, page: { ...page, items: [...rows.values()], projection: { ...page.projection!, visibility: [...hidden.values()] } } }
    if (this.diskWriting) return
    this.diskWriting = true
    this.persistence = (async () => {
      while (this.diskPending !== undefined) {
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
        const pending = this.diskPending
        this.diskPending = undefined
        try { await this.runtime.stateStore.writeDirectoryCache?.(pending.userId, pending.page); this.cacheFailure = undefined }
        catch (error) { this.cacheFailure = error; console.warn('dsh-arkme: directory_cache_write_failed', error instanceof Error ? error.message : 'cache failed') }
      }
    })().finally(() => { this.diskWriting = false })
  }

  private startAvatars(generation: number): void {
    if (this.avatarWork !== undefined) return
    const signal = this.controller.signal
    const pending = (async () => {
      while (this.avatars.size > 0 && generation === this.generation) {
        const items = [...this.avatars.values()].slice(0, PAGE_SIZE)
        for (const item of items) this.avatars.delete(keyOf(item))
        const hydrated = await this.source.hydrateDirectoryPage(items.map(item => this.sources.get(keyOf(item)) ?? item), signal)
        if (generation !== this.generation) return
        // Decorations cannot roll back message or preference changes made during hydration.
        this.apply(hydrated.map(item => ({ ...this.sources.get(keyOf(item))!,
          avatarRef: item.avatarRef ?? '',
          avatarRefs: item.avatarRefs ?? [],
          ...(item.groupAvatar === undefined ? {} : { groupAvatar: item.groupAvatar }),
        })))
        const refs = new Set(hydrated.flatMap(item => [item.avatarRef, ...(item.avatarRefs ?? [])]).filter((ref): ref is string => ref !== undefined && ref.trim() !== ''))
        for (const ref of refs) {
          signal.throwIfAborted()
          await this.warmAvatar(ref, signal).catch(() => undefined)
        }
        if (refs.size > 0 && generation === this.generation) {
          this.revision++
          const page = this.snapshot([], [])
          this.emit({ ...page, projection: { ...page.projection!, avatarRefs: [...refs] } })
        }
      }
    })().catch(() => { /* Decorations keep their last good snapshot and retry on the next directory sync. */ })
      .finally(() => { if (this.avatarWork === pending) this.avatarWork = undefined })
    this.avatarWork = pending
  }

  async forgetBot(botRef: string): Promise<void> {
    await this.activate()
    this.deletedBotRefs.add(botRef)
    this.bots = this.bots.filter(bot => bot.botRef !== botRef)
    this.publish([])
  }

  async pinBot(botRef: string, pinned: boolean): Promise<void> {
    await this.activate()
    const bot = this.bots.find(item => item.botRef === botRef)
    if (bot === undefined) throw new ArkmePluginError('bot-directory-entry-unavailable', '请先加载当前账号的 Bot 目录', false, 404)
    const key = bot.directoryKey ?? bot.botRef
    const previous = this.botPinnedKeys.has(key)
    if (pinned) this.botPinnedKeys.add(key)
    else this.botPinnedKeys.delete(key)
    this.publish([])
    await this.persistence
    if (this.cacheFailure !== undefined) {
      if (previous) this.botPinnedKeys.add(key); else this.botPinnedKeys.delete(key)
      this.publish([])
      throw new ArkmePluginError('directory-cache-write-failed', '本地置顶状态保存失败，请重试', true, 500)
    }
  }

  async rememberSpecial(patch: typeof this.special): Promise<void> {
    await this.activate()
    if (patch.arkoPreview !== undefined && this.special.arkoPreview !== undefined && patch.arkoPreview.createdAtMillis < this.special.arkoPreview.createdAtMillis) delete patch.arkoPreview
    const next = { ...this.special, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.special)) return
    this.special = next
    this.publish([])
  }

  async confirmVisibility(entryKind: 'source' | 'bot', entryRef: string, hidden: boolean): Promise<void> {
    await this.activate()
    this.apply([], [{ entryKind, entryRef, hidden }])
  }

  async confirmPin(sourceRef: string, pinned: boolean, policyUpdatedAtMillis: number): Promise<void> {
    await this.activate()
    const source = [...this.sources.values()].find(item => item.sourceRef === sourceRef)
    if (source !== undefined) this.apply([{ ...source, isPinned: pinned, chatPolicyUpdatedAtMillis: policyUpdatedAtMillis }])
  }

  async accept(event: ArkmeChatClientEvent): Promise<void> {
    const generation = this.generation
    const atRevision = this.revision
    if (this.userId === undefined || (await this.runtime.accountScopedSession())?.userId !== this.userId || generation !== this.generation) return
    if (event.type === 'sessions-delta') {
      const sources = event.updates.map(item => mergeDirectorySource(this.sources.get(keyOf(item.source)), item.source))
      const visibility = await this.preferences.query(sources.map(item => item.sourceRef), [], this.controller.signal)
      if (generation !== this.generation) return
      this.apply(sources, visibility.items, atRevision)
    } else if (event.type === 'read-ack') {
      const source = [...this.sources.values()].find(item => item.sourceKey === event.sourceKey || item.sourceRef === event.sourceRef)
      if (source !== undefined && (source.latestSequence ?? 0) <= event.effectiveReadSequence) this.apply([{ ...source, unreadCount: event.unreadCount, badgeUnreadCount: source.isMuted ? 0 : event.unreadCount, ...(event.unreadCount === 0 ? { hasUnreadMention: false } : {}) }])
    } else if (event.type === 'chat-pins-reconciled') {
      this.apply([...this.sources.values()].flatMap(source => {
        const pin = event.pins.find(item => item.sourceKey === source.sourceKey)
        return pin === undefined ? [] : [{ ...source, isPinned: pin.pinned, chatPolicyUpdatedAtMillis: pin.policyUpdatedAtMillis }]
      }))
    } else if (event.type === 'conversation-list-preference-invalidated') {
      if (this.scan === undefined) this.startScan()
    }
  }
}
