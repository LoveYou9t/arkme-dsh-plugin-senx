import { mergeMemberPresentation, mergeMemberJoinEvents } from '../member-directory.js'
import type { ArkmeConversationMemberItem, ArkmeConversationMemberList, ArkmeConversationMemberPage, ArkmeConversationMemberCache, ArkmeSourceItem } from '../types.js'
import { callArkme } from './api.js'

const MAX_IDLE_GROUPS = 20
const MAX_IDLE_MEMBERS = 20_000
const MAX_AGE_MS = 30_000
const INVALIDATION_DELAY_MS = 180
type Source = Pick<ArkmeSourceItem, 'sourceRef' | 'sourceKey'>
interface LoadingOptions {
  page?: (sourceRef: string, cursor: string | undefined, signal: AbortSignal) => Promise<ArkmeConversationMemberPage>
  presentation?: (sourceRef: string, memberRefs: string[], signal: AbortSignal) => Promise<ArkmeConversationMemberPage>
  cached?: (sourceRef: string, signal: AbortSignal) => Promise<ArkmeConversationMemberCache | null>
}
type Load = (sourceRef: string, signal: AbortSignal) => Promise<ArkmeConversationMemberList>

export interface ConversationMembersSnapshot {
  items: readonly ArkmeConversationMemberItem[]
  joinEvents: NonNullable<ArkmeConversationMemberList['joinEvents']>
  ready: boolean
  complete: boolean
  cached: boolean
  refreshing: boolean
  error: string | undefined
}

export const EMPTY_CONVERSATION_MEMBERS: ConversationMembersSnapshot = {
  items: [], joinEvents: [], ready: false, complete: false, cached: false, refreshing: false, error: undefined,
}

interface Entry {
  source: Source
  members: Map<string, ArkmeConversationMemberItem>
  snapshot: ConversationMembersSnapshot
  listeners: Set<() => void>
  revision: number
  refreshedAt: number
  stale: boolean
  pending: Promise<void> | undefined
  controller: AbortController | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

function key(source: Source): string { return source.sourceKey ?? source.sourceRef }

function memberAccessRevoked(error: unknown): boolean {
  const failure = error as { code?: string; body?: { code?: string } }
  const code = failure?.body?.code ?? failure?.code
  return code !== undefined && ['auth-http-401', 'auth-http-403', 'login-required', 'login-expired', 'source-ref-invalid', 'arkme-code-403', 'arkme-code-1004', 'chat-members-source-invalid'].includes(code)
}

function sameMember(left: ArkmeConversationMemberItem, right: ArkmeConversationMemberItem): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof ArkmeConversationMemberItem)[])
  return [...keys].every(field => left[field] === right[field])
}

/** One account/runtime-scoped member directory; React only observes its snapshots. */
export class ConversationMembersStore {
  private account: string | undefined
  private entries = new Map<string, Entry>()
  private foreground = true

  constructor(private readonly load?: Load, private readonly now = Date.now, private readonly loading: LoadingOptions = {}) {}


  activateAccount(account: string | undefined): void {
    if (account === this.account) return
    this.account = account
    const previous = [...this.entries.values()]
    this.entries.clear()
    for (const entry of previous) {
      this.cancel(entry)
      for (const listener of entry.listeners) listener()
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      this.cancel(entry)
      entry.revision += 1
      entry.members.clear()
      entry.stale = true
      entry.refreshedAt = 0
      this.publish(entry, EMPTY_CONVERSATION_MEMBERS)
      this.schedule(entry)
    }
  }

  get(account: string | undefined, source: Source | undefined): ConversationMembersSnapshot {
    return account === this.account && source !== undefined
      ? this.entries.get(key(source))?.snapshot ?? EMPTY_CONVERSATION_MEMBERS
      : EMPTY_CONVERSATION_MEMBERS
  }

  subscribe(account: string, source: Source, listener: () => void): () => void {
    this.activateAccount(account)
    const identity = key(source)
    let entry = this.entries.get(identity)
    if (entry === undefined) {
      entry = {
        source, members: new Map(), snapshot: EMPTY_CONVERSATION_MEMBERS, listeners: new Set(),
        revision: 0, refreshedAt: 0, stale: true, pending: undefined, controller: undefined, timer: undefined,
      }
      this.entries.set(identity, entry)
    }
    if (entry.source.sourceRef !== source.sourceRef) {
      entry.revision += 1
      entry.stale = true
      this.cancel(entry)
    }
    entry.source = source
    entry.listeners.add(listener)
    this.entries.delete(identity)
    this.entries.set(identity, entry)
    const current = entry
    // Wait until React has finished subscribing, including Strict Mode's remount.
    queueMicrotask(() => {
      if (this.entries.get(identity) === current && current.listeners.size > 0) void this.ensure(account, current.source)
    })
    this.evict()
    return () => {
      current.listeners.delete(listener)
      queueMicrotask(() => {
        if (current.listeners.size === 0) { this.cancel(current); this.evict() }
      })
    }
  }

  async ensure(account: string, source: Source, force = false): Promise<void> {
    const entry = account === this.account ? this.entries.get(key(source)) : undefined
    if (entry === undefined || entry.listeners.size === 0 || !this.foreground) return
    entry.source = source
    if (entry.pending !== undefined) return await entry.pending
    if (!force && !entry.stale && this.now() - entry.refreshedAt < MAX_AGE_MS) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    const revision = entry.revision
    const controller = new AbortController()
    entry.controller = controller
    entry.stale = false
    this.publish(entry, { refreshing: true, error: undefined })
    entry.pending = Promise.resolve().then(() => this.load !== undefined
      ? this.load(source.sourceRef, controller.signal)
      : this.loadPages(account, entry, revision, controller))
      .then(result => {
        if (result === undefined) return
        if (controller.signal.aborted || this.entries.get(key(source)) !== entry || account !== this.account) return
        if (revision !== entry.revision) return
        // Only a complete, matching baseline may remove absent members. Never trim a partial page.
        if ((result.source.sourceKey ?? result.source.sourceRef) !== key(source)
          || result.total !== result.items.length
          || result.activeCount !== result.items.length
          || new Set(result.items.map(member => member.memberRef)).size !== result.items.length
          || result.items.some(member => member.memberRef.trim() === '' || member.status !== 'active')) {
          throw new Error('成员列表响应不完整，请重试')
        }
        const seen = new Set<string>()
        const items = result.items.map(incoming => {
          seen.add(incoming.memberRef)
          const previous = entry.members.get(incoming.memberRef)
          // Optional enrichment may fail; it must not erase a previously usable avatar/name.
          const member = previous === undefined ? incoming : {
            ...incoming,
            ...(incoming.avatarRef === undefined && previous.avatarRef !== undefined ? { avatarRef: previous.avatarRef } : {}),
            ...(['', '群成员', '成员'].includes(incoming.displayName) ? { displayName: previous.displayName } : {}),
          }
          const value = previous !== undefined && sameMember(previous, member) ? previous : member
          entry.members.set(member.memberRef, value)
          return value
        })
        for (const memberRef of entry.members.keys()) if (!seen.has(memberRef)) entry.members.delete(memberRef)
        const unchanged = items.length === entry.snapshot.items.length
          && items.every((member, index) => member === entry.snapshot.items[index])
        const joinEvents = result.joinEvents ?? []
        entry.refreshedAt = this.now()
        this.publish(entry, {
          items: unchanged ? entry.snapshot.items : items,
          joinEvents: JSON.stringify(joinEvents) === JSON.stringify(entry.snapshot.joinEvents) ? entry.snapshot.joinEvents : joinEvents,
          ready: true, complete: true, cached: false, error: undefined,
        })
      })
      .catch(error => {
        if (controller.signal.aborted || account !== this.account || this.entries.get(key(source)) !== entry) return
        if (revision !== entry.revision) return
        if (memberAccessRevoked(error)) {
          controller.abort()
          entry.members.clear()
          this.publish(entry, EMPTY_CONVERSATION_MEMBERS)
        }
        entry.stale = true
        this.publish(entry, { error: error instanceof Error ? error.message : '成员加载失败，请重试' })
      })
      .finally(() => {
        if (entry.controller !== controller) return
        entry.pending = undefined
        entry.controller = undefined
        this.publish(entry, { refreshing: false })
        if (revision !== entry.revision) this.schedule(entry)
      })
    await entry.pending
  }

  private async loadPages(account: string, entry: Entry, revision: number, controller: AbortController): Promise<ArkmeConversationMemberList | undefined> {
    const current = () => !controller.signal.aborted && this.account === account && this.entries.get(key(entry.source)) === entry && revision === entry.revision
    let remoteProgress = false
    const sourceRef = entry.source.sourceRef
    const cached = this.loading.cached ?? ((ref, signal) => callArkme<ArkmeConversationMemberCache | null>('source.members.cached', { sourceRef: ref }, signal))
    if (!entry.snapshot.ready) void cached(sourceRef, controller.signal).then(value => {
      if (!current() || remoteProgress || value === null || value === undefined) return
      if (!Array.isArray(value.items) || value.items.length > MAX_IDLE_MEMBERS || value.items.some(member => !member.memberRef || member.status !== 'active')) return
      this.applyPage(entry, { source: { ...entry.source } as ArkmeSourceItem, items: value.items, removedMemberRefs: [],
        hasMore: false, presentationComplete: true, joinEvents: value.joinEvents })
      this.publish(entry, { cached: true, complete: false })
    }).catch(() => undefined)
    const loadPage = this.loading.page ?? ((ref, cursor, signal) => callArkme<ArkmeConversationMemberPage>('source.members.page', {
      sourceRef: ref, limit: 50, ...(cursor === undefined ? {} : { cursor }),
    }, signal))
    const loadPresentation = this.loading.presentation ?? ((ref, memberRefs, signal) => callArkme<ArkmeConversationMemberPage>('source.members.presentation', {
      sourceRef: ref, memberRefs,
    }, signal))
    const seen = new Set<string>()
    const cursors = new Set<string>()
    const pending = new Set<Promise<void>>()
    let presentationFailed = false
    const enrich = (refs: string[]) => {
      const work = loadPresentation(sourceRef, refs, controller.signal).then(page => {
        if (!current()) return
        this.applyPage(entry, page)
        if (!page.presentationComplete) presentationFailed = true
      }).catch(error => {
        if (!current()) return
        if (memberAccessRevoked(error)) {
          this.clear(account, entry.source)
          this.publish(entry, { error: error instanceof Error ? error.message : '群成员访问权限已失效' })
        } else presentationFailed = true
      }).finally(() => { pending.delete(work) })
      pending.add(work)
    }
    let cursor: string | undefined
    try {
      for (let index = 0; index < 200; index++) {
        if (!current()) return
        let page: ArkmeConversationMemberPage
        try { page = await loadPage(sourceRef, cursor, controller.signal) }
        catch (error) {
          if (index === 0 && (error as { body?: { code?: string } }).body?.code === 'member-pagination-unavailable') {
            return await callArkme('source.members', { sourceRef, activeOnly: true }, controller.signal)
          }
          throw error
        }
        if (!current()) return
        remoteProgress = true
        this.applyPage(entry, page)
        this.publish(entry, { cached: false })
        for (const member of page.items) seen.add(member.memberRef)
        for (const ref of page.removedMemberRefs) seen.add(ref)
        if (!page.presentationComplete) {
          for (let start = 0; start < page.items.length; start += 50) {
            enrich(page.items.slice(start, start + 50).map(member => member.memberRef))
            if (pending.size >= 2) await Promise.race(pending)
          }
        }
        if (!page.hasMore) {
          // Paged live traversal is not an atomic snapshot. Verify missing cached members explicitly.
          const missing = [...entry.members.keys()].filter(ref => !seen.has(ref))
          for (let start = 0; start < missing.length; start += 50) {
            if (!current()) return
            enrich(missing.slice(start, start + 50))
            if (pending.size >= 2) await Promise.race(pending)
          }
          await Promise.all(pending)
          if (!current()) return
          entry.refreshedAt = this.now()
          entry.stale = presentationFailed
          this.publish(entry, { complete: true, cached: false, error: presentationFailed ? '部分成员资料未更新，请重试' : undefined })
          return
        }
        if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('成员分页游标重复或缺失，请重试')
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      throw new Error('成员分页超过本次加载上限，已保留当前列表，请重试')
    } finally { await Promise.all(pending) }
  }

  private applyPage(entry: Entry, page: ArkmeConversationMemberPage): void {
    if (key(page.source) !== key(entry.source) || !Array.isArray(page.items) || !Array.isArray(page.removedMemberRefs)
      || new Set(page.items.map(member => member.memberRef)).size !== page.items.length
      || page.items.some(member => !member.memberRef || member.status !== 'active')) throw new Error('成员分页响应无效')
    let changed = false
    for (const incoming of page.items) {
      const previous = entry.members.get(incoming.memberRef)
      const member = mergeMemberPresentation(previous, incoming, page.presentationComplete)
      if (previous !== undefined && sameMember(previous, member)) continue
      entry.members.set(incoming.memberRef, member)
      changed = true
    }
    for (const ref of page.removedMemberRefs) if (entry.members.delete(ref)) changed = true
    const rank = (role: string) => role === 'owner' ? 0 : role === 'admin' ? 1 : role === 'member' ? 2 : 3
    const items = changed ? [...entry.members.values()].sort((left, right) => rank(left.role) - rank(right.role)
      || left.joinedAtMillis - right.joinedAtMillis || left.displayName.localeCompare(right.displayName)) : entry.snapshot.items
    const joins = mergeMemberJoinEvents(entry.snapshot.joinEvents, page.joinEvents ?? [])
    this.publish(entry, { items, ready: true, joinEvents: JSON.stringify(joins) === JSON.stringify(entry.snapshot.joinEvents) ? entry.snapshot.joinEvents : joins })
  }

  invalidate(account: string | undefined, source: Source): void {
    if (account !== this.account) return
    const entry = this.entries.get(key(source))
    if (entry === undefined) return
    entry.revision += 1
    entry.stale = true
    this.schedule(entry)
  }

  remove(account: string | undefined, source: Source, memberRef: string): void {
    if (account !== this.account) return
    const entry = this.entries.get(key(source))
    if (entry === undefined) return
    if (entry.members.delete(memberRef)) this.publish(entry, {
      items: entry.snapshot.items.filter(member => member.memberRef !== memberRef),
    })
    this.invalidate(account, source)
  }

  clear(account: string | undefined, source: Source): void {
    if (account !== this.account) return
    const entry = this.entries.get(key(source))
    if (entry === undefined) return
    this.cancel(entry)
    entry.revision += 1
    entry.members.clear()
    entry.refreshedAt = this.now()
    entry.stale = false
    this.publish(entry, EMPTY_CONVERSATION_MEMBERS)
  }

  refreshActive(): void {
    if (this.account === undefined) return
    for (const entry of this.entries.values()) {
      if (entry.stale || this.now() - entry.refreshedAt >= MAX_AGE_MS) this.schedule(entry)
    }
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (foreground) this.refreshActive()
    else for (const entry of this.entries.values()) this.cancel(entry)
  }

  private schedule(entry: Entry): void {
    if (!this.foreground || entry.listeners.size === 0 || entry.pending !== undefined || entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (this.account !== undefined) void this.ensure(this.account, entry.source)
    }, INVALIDATION_DELAY_MS)
  }

  private publish(entry: Entry, patch: Partial<ConversationMembersSnapshot>): void {
    if (Object.entries(patch).every(([field, value]) => entry.snapshot[field as keyof ConversationMembersSnapshot] === value)) return
    entry.snapshot = { ...entry.snapshot, ...patch }
    for (const listener of entry.listeners) listener()
  }

  private cancel(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.controller !== undefined) entry.stale = true
    entry.controller?.abort()
    entry.controller = undefined
    entry.pending = undefined
    this.publish(entry, { refreshing: false })
  }

  private evict(): void {
    let idle = [...this.entries.values()].filter(entry => entry.listeners.size === 0).length
    let members = [...this.entries.values()].reduce((total, entry) => total + (entry.listeners.size === 0 ? entry.members.size : 0), 0)
    for (const [identity, entry] of this.entries) {
      if (idle <= MAX_IDLE_GROUPS && members <= MAX_IDLE_MEMBERS) break
      if (entry.listeners.size > 0) continue
      members -= entry.members.size
      this.cancel(entry)
      this.entries.delete(identity)
      idle -= 1
    }
  }
}

export const arkmeConversationMembers = new ConversationMembersStore()
