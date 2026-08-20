import { ArkmeChatRealtimeRuntime, type ArkmeChatRealtimeNotice } from '../chat-realtime.js'
import type { ArkmeSessionCredentials } from '../keychain-store.js'
import type {
  ArkmeChatClientEvent,
  ArkmeChatRealtimeState,
  ArkmeSourceItem,
  ArkmeTimelineItem,
} from '../types.js'
import { SourceService } from './source-service.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'

export interface ArkmeChatProjectionReader {
  chatTimelineItems(data: Record<string, unknown>, session: ArkmeSessionCredentials): Promise<ArkmeTimelineItem[]>
}

const MAX_PROJECTION_RETRIES = 5

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function listValue(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

function safeFailureMessage(error: unknown): string {
  if (error instanceof ArkmePluginError) return error.message
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return '未知错误'
}

export class ChatRealtimeService {
  private readonly chatRealtime: ArkmeChatRealtimeRuntime
  private readonly chatClientListeners = new Set<(event: ArkmeChatClientEvent) => void>()
  private readonly pendingProjectionSequences = new Map<string, number>()
  private readonly projectionRetryCounts = new Map<string, number>()
  private projectionTimer: ReturnType<typeof setTimeout> | undefined
  private projectionInFlight = false
  private projectionFailureCount = 0
  private chatClientRevision = 0

  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
    private readonly projectionReader: ArkmeChatProjectionReader,
  ) {
    this.chatRealtime = new ArkmeChatRealtimeRuntime({
      imBaseUrl: runtime.config.imBaseUrl,
      readSession: async () => await runtime.sessionStore.read(),
      refreshSession: async session => {
        try { return await runtime.refreshAccessToken(session) }
        catch (error) {
          console.warn('dsh-arkme: Chat SSE credential refresh paused:', safeFailureMessage(error))
          return undefined
        }
      },
      fetchImpl: runtime.fetchImpl,
    })
  }

  reconnect(): void {
    this.chatRealtime.reconnect()
  }

  dispose(): void {
    if (this.projectionTimer !== undefined) clearTimeout(this.projectionTimer)
    this.projectionTimer = undefined
    this.pendingProjectionSequences.clear()
    this.projectionRetryCounts.clear()
    this.chatClientListeners.clear()
  }

  startChatRealtime(): () => void {
    const unsubscribe = this.chatRealtime.subscribe(notice => { this.handleChatRealtimeNotice(notice) })
    const stop = this.chatRealtime.start()
    return () => {
      unsubscribe()
      stop()
      if (this.projectionTimer !== undefined) clearTimeout(this.projectionTimer)
      this.projectionTimer = undefined
      this.pendingProjectionSequences.clear()
      this.projectionRetryCounts.clear()
    }
  }

  chatRealtimeState(): ArkmeChatRealtimeState {
    return this.chatRealtime.state()
  }

  subscribeChatRealtime(listener: (event: ArkmeChatClientEvent) => void): () => void {
    this.chatClientListeners.add(listener)
    return () => { this.chatClientListeners.delete(listener) }
  }

  chatRealtimeInitialEvent(): ArkmeChatClientEvent {
    const state = this.chatRealtime.state()
    return { type: 'reconcile', revision: this.chatClientRevision, connected: state.connected, refresh: 'if-stale' }
  }

  handleChatRealtimeNotice(notice: ArkmeChatRealtimeNotice): void {
    if (notice.cause === 'reconcile') {
      this.emitChatClientEvent({
        type: 'reconcile', revision: this.nextChatClientRevision(), connected: notice.state.connected, refresh: 'none',
      })
      return
    }
    if (notice.cause === 'hint' && notice.hint !== undefined) {
      this.scheduleChatSessionProjection(notice.hint.chatSessionUid, notice.hint.latestSequence)
    }
  }

  scheduleChatSessionProjection(chatSessionUid: string, latestSequence: number): void {
    const uid = chatSessionUid.trim()
    if (uid === '') return
    if (latestSequence > (this.pendingProjectionSequences.get(uid) ?? 0)) this.projectionRetryCounts.delete(uid)
    this.pendingProjectionSequences.set(uid, Math.max(latestSequence, this.pendingProjectionSequences.get(uid) ?? 0))
    if (this.projectionTimer !== undefined || this.projectionInFlight) return
    this.projectionTimer = setTimeout(() => {
      this.projectionTimer = undefined
      void this.flushChatSessionProjections()
    }, 200)
  }

  private async flushChatSessionProjections(): Promise<void> {
    if (this.projectionInFlight || this.pendingProjectionSequences.size === 0) return
    this.projectionInFlight = true
    const pending = [...this.pendingProjectionSequences.entries()].slice(0, 50)
    for (const [uid] of pending) this.pendingProjectionSequences.delete(uid)
    try {
      const failed = await this.refreshChatSessionProjectionBatch(pending)
      for (const [uid] of pending) {
        if (!failed.some(([failedUid]) => failedUid === uid)) this.projectionRetryCounts.delete(uid)
      }
      if (failed.length === 0) {
        this.projectionFailureCount = 0
      } else {
        this.projectionFailureCount += 1
        this.requeueProjectionFailures(failed)
      }
    } catch (error) {
      console.warn('dsh-arkme: Chat incremental projection failed:', safeFailureMessage(error))
      this.projectionFailureCount += 1
      this.requeueProjectionFailures(pending)
    } finally {
      this.projectionInFlight = false
      if (this.pendingProjectionSequences.size > 0 && this.projectionTimer === undefined) {
        const retryDelayBase = this.projectionFailureCount === 0
          ? 200
          : Math.min(5_000, 500 * 2 ** Math.min(3, this.projectionFailureCount - 1))
        const retryDelay = Math.max(100, Math.round(retryDelayBase * (0.8 + Math.random() * 0.4)))
        this.projectionTimer = setTimeout(() => {
          this.projectionTimer = undefined
          void this.flushChatSessionProjections()
        }, retryDelay)
      }
    }
  }

  private requeueProjectionFailures(failed: Array<[string, number]>): void {
    for (const [uid, sequence] of failed) {
      const retries = (this.projectionRetryCounts.get(uid) ?? 0) + 1
      if (retries > MAX_PROJECTION_RETRIES) {
        this.projectionRetryCounts.delete(uid)
        console.warn('dsh-arkme: Chat projection retry exhausted for one session')
        continue
      }
      this.projectionRetryCounts.set(uid, retries)
      this.pendingProjectionSequences.set(uid, Math.max(sequence, this.pendingProjectionSequences.get(uid) ?? 0))
    }
  }

  async refreshChatSessionProjectionBatch(
    pending: Array<[string, number]>,
  ): Promise<Array<[string, number]>> {
    const session = await this.runtime.requireSession()
    const sessionUids = pending.map(([uid]) => uid).sort()
    const projectionBatchKey = sessionUids.join('|')
    const displayData = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/display-snapshots', { chat_session_uids: sessionUids }, session,
      undefined,
      {
        lane: 'background-read',
        key: `projection:display:${projectionBatchKey}`,
      },
    )
    const bundles = new Map(listValue(displayData.items).map(raw => {
      const bundle = objectValue(raw)
      return [stringValue(objectValue(bundle.session).chat_session_uid).trim(), bundle] as const
    }).filter(([uid]) => uid !== ''))
    const tailItemsByUid = new Map<string, ArkmeTimelineItem[]>()
    const failedUids = new Set<string>()
    for (let offset = 0; offset < pending.length; offset += 3) {
      const chunk = pending.slice(offset, offset + 3)
      const results = await Promise.allSettled(chunk.map(async ([uid, hintedSequence]) => {
        const cached = this.source.cachedChatSourceByKey(`${String(session.userId)}:${uid}`)
        const afterSequence = Math.max(0, cached?.latestSequence ?? hintedSequence - 1)
        const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
          '/api/v1/chat/timeline/tail', { chat_session_uid: uid, after_seq: afterSequence, limit: 50 }, session,
          undefined,
          {
            lane: 'background-read',
            key: `projection:tail:${uid}:${String(afterSequence)}`,
          },
        )
        return [uid, await this.projectionReader.chatTimelineItems(data, session)] as const
      }))
      results.forEach((result, index) => {
        const uid = chunk[index]?.[0]
        if (uid === undefined) return
        if (result.status === 'fulfilled') tailItemsByUid.set(result.value[0], result.value[1])
        else failedUids.add(uid)
      })
    }
    const updates: Array<{ sourceKey: string; source: ArkmeSourceItem; timelineItems: ArkmeTimelineItem[] }> = []
    for (const [uid] of pending) {
      const bundle = bundles.get(uid)
      if (bundle === undefined || failedUids.has(uid)) {
        failedUids.add(uid)
        continue
      }
      const cacheKey = `${String(session.userId)}:${uid}`
      const timelineItems = tailItemsByUid.get(uid) ?? []
      try {
        const source = await this.source.chatSourceFromBundle(bundle, session, this.source.cachedChatSourceByKey(cacheKey), timelineItems)
        this.source.setChatSourceByKey(cacheKey, source)
        updates.push({ sourceKey: source.sourceKey ?? await this.source.chatDirectorySourceKey(session.userId, uid), source, timelineItems })
      } catch {
        failedUids.add(uid)
      }
    }
    if (updates.length > 0) {
      this.source.invalidateSourceListCache(session.userId, 'root')
      this.emitChatClientEvent({
        type: 'sessions-delta',
        revision: this.nextChatClientRevision(),
        updates,
      })
    }
    return pending.filter(([uid]) => failedUids.has(uid))
  }

  emitChatClientEvent(event: ArkmeChatClientEvent): void {
    for (const listener of [...this.chatClientListeners]) listener(event)
  }

  nextChatClientRevision(): number {
    this.chatClientRevision += 1
    return this.chatClientRevision
  }
}
