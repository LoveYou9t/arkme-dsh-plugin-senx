import { createHmac } from 'node:crypto'
import type { ArkmeSessionCredentials } from '../keychain-store.js'
import type {
  ArkmeArrangementDetail,
  ArkmeArrangementItem,
  ArkmeArrangementListStatus,
  ArkmeArrangementMutationIntent,
  ArkmeArrangementMutationResult,
  ArkmeArrangementPage,
  ArkmeArrangementReminderEvent,
  ArkmeArrangementReminderPage,
  ArkmeArrangementReminderSummary,
  ArkmeArrangementReminderToggleResult,
  ArkmeArrangementReminderWriteResult,
  ArkmeArrangementStatus,
} from '../types.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'

interface ArkmeArrangementRefEntry {
  viewerUserId: number
  arrangementUid: string
  expiresAtMillis: number
}

interface ArkmeArrangementReminderRefEntry {
  viewerUserId: number
  eventUid: string
  expiresAtMillis: number
}

const ARKME_ARRANGEMENT_REF_TTL_MILLIS = 15 * 60 * 1000
const MAX_ARKME_ARRANGEMENT_REFS = 4096
const ARKME_ARRANGEMENT_REMINDER_REF_TTL_MILLIS = 15 * 60 * 1000
const MAX_ARKME_ARRANGEMENT_REMINDER_REFS = 4096

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function arrangementStatusCode(status: ArkmeArrangementListStatus): number {
  if (status === 'identified') return 1
  if (status === 'following') return 2
  if (status === 'completed') return 3
  return -1
}

function arrangementStatus(value: unknown): ArkmeArrangementStatus {
  const code = Math.trunc(numberValue(value))
  if (code === 1) return 'identified'
  if (code === 2) return 'following'
  if (code === 3) return 'completed'
  return 'unknown'
}

function arrangementMutationPath(intent: ArkmeArrangementMutationIntent): string {
  switch (intent) {
    case 'start-follow': return '/api/v1/arrangements/start-follow'
    case 'cancel-follow': return '/api/v1/arrangements/cancel-follow'
    case 'complete': return '/api/v1/arrangements/complete'
    case 'cancel-complete': return '/api/v1/arrangements/cancel-complete'
    case 'delete': return '/api/v1/arrangements/delete'
  }
}

function arrangementMutationExpectedStatus(
  intent: Exclude<ArkmeArrangementMutationIntent, 'delete'>,
): ArkmeArrangementStatus {
  switch (intent) {
    case 'start-follow':
    case 'cancel-complete':
      return 'following'
    case 'cancel-follow':
      return 'identified'
    case 'complete':
      return 'completed'
  }
}

function isAmbiguousArrangementWriteError(error: unknown): boolean {
  return error instanceof ArkmePluginError && error.retryable
}

export class ArrangementService {
  private readonly arrangementRefs = new Map<string, ArkmeArrangementRefEntry>()
  private readonly arrangementReminderRefs = new Map<string, ArkmeArrangementReminderRefEntry>()
  private readonly arrangementWrites = new Set<string>()

  constructor(private readonly runtime: ServiceRuntime) {}

  dispose(): void {
    this.arrangementRefs.clear()
    this.arrangementReminderRefs.clear()
    this.arrangementWrites.clear()
  }

  async listArrangements(
    options: { status?: ArkmeArrangementListStatus; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<ArkmeArrangementPage> {
    const session = await this.runtime.requireSession()
    const status = options.status ?? 'all'
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
      '/api/v1/arrangements/list',
      { status: arrangementStatusCode(status), limit, offset },
      session,
      options.signal,
      { lane: 'interactive-read' },
    )
    const rawItems = listValue(data.list)
    const items = await Promise.all(rawItems.map(async raw => await this.arrangementItem(raw, session.userId)))
    const total = Math.max(0, Math.trunc(numberValue(data.total)))
    const nextOffset = offset + rawItems.length
    const hasMore = rawItems.length > 0 && nextOffset < total
    return { items, total, hasMore, ...(hasMore ? { nextOffset } : {}) }
  }

  async arrangementDetail(arrangementRef: string, signal?: AbortSignal): Promise<ArkmeArrangementDetail> {
    const session = await this.runtime.requireSession()
    const reference = this.openArrangementRef(arrangementRef, session.userId)
    return await this.arrangementOwnerDetail(reference.arrangementUid, session, signal)
  }

  async listArrangementReminders(
    options: { unreadOnly?: boolean; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<ArkmeArrangementReminderPage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
      '/api/v1/arrangements/reminders/list',
      { limit, offset, unread_only: options.unreadOnly === true },
      session,
      options.signal,
      { lane: 'interactive-read' },
    )
    const rawItems = listValue(data.list)
    const items = await Promise.all(rawItems.map(async raw => await this.arrangementReminderEvent(raw, session.userId)))
    const total = Math.max(0, Math.trunc(numberValue(data.total)))
    const nextOffset = offset + rawItems.length
    const hasMore = rawItems.length > 0 && nextOffset < total
    return { items, total, hasMore, ...(hasMore ? { nextOffset } : {}) }
  }

  async arrangementReminderSummary(signal?: AbortSignal): Promise<ArkmeArrangementReminderSummary> {
    const session = await this.runtime.requireSession()
    const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
      '/api/v1/arrangements/reminders/summary',
      {},
      session,
      signal,
      { lane: 'interactive-read' },
    )
    const project = async (raw: unknown): Promise<ArkmeArrangementReminderEvent | undefined> => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      return await this.arrangementReminderEvent(raw, session.userId)
    }
    const [latestUnread, latestEvent, nextReminder] = await Promise.all([
      project(data.latest_unread),
      project(data.latest_event),
      project(data.next_reminder),
    ])
    return {
      unreadCount: Math.max(0, Math.trunc(numberValue(data.unread_count))),
      ...(latestUnread === undefined ? {} : { latestUnread }),
      ...(latestEvent === undefined ? {} : { latestEvent }),
      ...(nextReminder === undefined ? {} : { nextReminder }),
    }
  }

  async mutateArrangement(
    arrangementRef: string,
    intent: ArkmeArrangementMutationIntent,
    signal?: AbortSignal,
  ): Promise<ArkmeArrangementMutationResult> {
    const session = await this.runtime.requireSession()
    const normalizedRef = arrangementRef.trim()
    const reference = this.openArrangementRef(normalizedRef, session.userId)
    return await this.withArrangementWrite(normalizedRef, session.userId, async () => {
      let ambiguous = false
      try {
        await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
          arrangementMutationPath(intent),
          { uid: reference.arrangementUid },
          session,
          signal,
        )
      } catch (error) {
        if (!isAmbiguousArrangementWriteError(error)) throw error
        ambiguous = true
      }

      if (intent === 'delete') {
        if (!ambiguous) {
          this.arrangementRefs.delete(normalizedRef)
          return { arrangementRef: normalizedRef, intent, outcome: 'confirmed', deleted: true }
        }
        const result = await this.reconcileArrangementDelete(normalizedRef, reference.arrangementUid, session)
        if (result.deleted === true) this.arrangementRefs.delete(normalizedRef)
        return result
      }

      let item: ArkmeArrangementItem | undefined
      try {
        item = await this.arrangementOwnerDetail(reference.arrangementUid, session, ambiguous ? undefined : signal)
      } catch {
        return { arrangementRef: normalizedRef, intent, outcome: ambiguous ? 'unknown' : 'confirmed' }
      }
      if (!ambiguous) return { arrangementRef: normalizedRef, intent, outcome: 'confirmed', item }
      const expectedStatus = arrangementMutationExpectedStatus(intent)
      return {
        arrangementRef: normalizedRef,
        intent,
        outcome: item.status === expectedStatus ? 'reconciled' : 'unknown',
        item,
      }
    })
  }

  async setArrangementReminderEnabled(
    arrangementRef: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<ArkmeArrangementReminderToggleResult> {
    const session = await this.runtime.requireSession()
    const normalizedRef = arrangementRef.trim()
    const reference = this.openArrangementRef(normalizedRef, session.userId)
    return await this.withArrangementWrite(normalizedRef, session.userId, async () => {
      let ambiguous = false
      try {
        await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
          '/api/v1/arrangements/reminder-enabled',
          { uid: reference.arrangementUid, reminder_enabled: enabled },
          session,
          signal,
        )
      } catch (error) {
        if (!isAmbiguousArrangementWriteError(error)) throw error
        ambiguous = true
      }
      let item: ArkmeArrangementItem | undefined
      try {
        item = await this.arrangementOwnerDetail(reference.arrangementUid, session, ambiguous ? undefined : signal)
      } catch {
        return { arrangementRef: normalizedRef, enabled, outcome: ambiguous ? 'unknown' : 'confirmed' }
      }
      return {
        arrangementRef: normalizedRef,
        enabled,
        outcome: ambiguous
          ? item.reminderEnabled === enabled ? 'reconciled' : 'unknown'
          : 'confirmed',
        item,
      }
    })
  }

  async markArrangementRemindersRead(
    eventRefs: readonly string[],
    signal?: AbortSignal,
  ): Promise<ArkmeArrangementReminderWriteResult> {
    const session = await this.runtime.requireSession()
    if (eventRefs.length === 0 || eventRefs.length > 50) {
      throw new ArkmePluginError('arrangement-reminder-refs-invalid', '请选择 1 至 50 条安排提醒', false)
    }
    const eventUids = [...new Set(eventRefs.map(eventRef => {
      return this.openArrangementReminderRef(eventRef, session.userId).eventUid
    }))]
    return await this.withArrangementWrite('reminders', session.userId, async () => {
      try {
        const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
          '/api/v1/arrangements/reminders/mark-read',
          { event_uids: eventUids, mark_all: false },
          session,
          signal,
        )
        return { outcome: 'confirmed', updatedCount: Math.max(0, Math.trunc(numberValue(data.updated_count))) }
      } catch (error) {
        if (!isAmbiguousArrangementWriteError(error)) throw error
        return { outcome: 'unknown' }
      }
    })
  }

  async markAllArrangementRemindersRead(signal?: AbortSignal): Promise<ArkmeArrangementReminderWriteResult> {
    const session = await this.runtime.requireSession()
    return await this.withArrangementWrite('reminders', session.userId, async () => {
      try {
        const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
          '/api/v1/arrangements/reminders/mark-read',
          { event_uids: [], mark_all: true },
          session,
          signal,
        )
        return { outcome: 'confirmed', updatedCount: Math.max(0, Math.trunc(numberValue(data.updated_count))) }
      } catch (error) {
        if (!isAmbiguousArrangementWriteError(error)) throw error
        return { outcome: 'unknown' }
      }
    })
  }

  async clearArrangementReminders(signal?: AbortSignal): Promise<ArkmeArrangementReminderWriteResult> {
    const session = await this.runtime.requireSession()
    return await this.withArrangementWrite('reminders', session.userId, async () => {
      try {
        const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
          '/api/v1/arrangements/reminders/clear',
          {},
          session,
          signal,
        )
        return { outcome: 'confirmed', updatedCount: Math.max(0, Math.trunc(numberValue(data.updated_count))) }
      } catch (error) {
        if (!isAmbiguousArrangementWriteError(error)) throw error
        try {
          const page = await this.listArrangementReminders({ limit: 1, offset: 0 })
          return { outcome: page.total === 0 && page.items.length === 0 ? 'reconciled' : 'unknown' }
        } catch {
          return { outcome: 'unknown' }
        }
      }
    })
  }

  private async withArrangementWrite<T>(
    arrangementRef: string,
    userId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${String(userId)}:${arrangementRef}`
    if (this.arrangementWrites.has(key)) {
      throw new ArkmePluginError(
        'arrangement-write-pending',
        '这条安排正在处理中，请等待当前操作完成',
        false,
        409,
      )
    }
    this.arrangementWrites.add(key)
    try {
      return await operation()
    } finally {
      this.arrangementWrites.delete(key)
    }
  }

  private async arrangementOwnerDetail(
    arrangementUid: string,
    session: ArkmeSessionCredentials,
    signal?: AbortSignal,
  ): Promise<ArkmeArrangementItem> {
    const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
      '/api/v1/arrangements/detail',
      { uid: arrangementUid },
      session,
      signal,
      { lane: 'interactive-read' },
    )
    if (stringValue(data.uid).trim() !== arrangementUid) {
      throw new ArkmePluginError('arrangement-contract-invalid', '安排详情响应身份不一致', true, 502)
    }
    return await this.arrangementItem(data, session.userId)
  }

  private async reconcileArrangementDelete(
    arrangementRef: string,
    arrangementUid: string,
    session: ArkmeSessionCredentials,
  ): Promise<ArkmeArrangementMutationResult> {
    try {
      const data = await this.runtime.authenticatedIntelligentPost<Record<string, unknown>>(
        '/api/v1/arrangements/list',
        { status: -1, uids: [arrangementUid], limit: 1, offset: 0 },
        session,
        undefined,
        { lane: 'interactive-read' },
      )
      const visible = listValue(data.list).find(raw => stringValue(objectValue(raw).uid).trim() === arrangementUid)
      if (visible === undefined) {
        return { arrangementRef, intent: 'delete', outcome: 'reconciled', deleted: true }
      }
      return {
        arrangementRef,
        intent: 'delete',
        outcome: 'unknown',
        deleted: false,
        item: await this.arrangementItem(visible, session.userId),
      }
    } catch {
      return { arrangementRef, intent: 'delete', outcome: 'unknown' }
    }
  }

  private async arrangementItem(raw: unknown, viewerUserId: number): Promise<ArkmeArrangementItem> {
    const item = objectValue(raw)
    const arrangementUid = stringValue(item.uid).trim()
    if (arrangementUid === '') {
      throw new ArkmePluginError('arrangement-contract-invalid', '安排响应缺少业务身份', true, 502)
    }
    const dueAtMillis = Math.trunc(numberValue(item.due_at))
    const remindAtMillis = Math.trunc(numberValue(item.remind_at))
    return {
      arrangementRef: await this.arrangementRef(viewerUserId, arrangementUid),
      title: stringValue(item.title),
      description: stringValue(item.description),
      status: arrangementStatus(item.status),
      reminderEnabled: booleanValue(item.reminder_enabled),
      reminderState: stringValue(item.reminder_state),
      createdAtMillis: Math.trunc(numberValue(item.create_at)),
      updatedAtMillis: Math.trunc(numberValue(item.update_at)),
      ...(dueAtMillis > 0 ? { dueAtMillis } : {}),
      ...(remindAtMillis > 0 ? { remindAtMillis } : {}),
    }
  }

  private async arrangementRef(viewerUserId: number, arrangementUid: string): Promise<string> {
    const digest = createHmac('sha256', await this.runtime.stateStore.uniqueCode())
      .update(`arrangement-v1:${String(viewerUserId)}:${arrangementUid}`)
      .digest('base64url')
    const arrangementRef = `arkme-arrangement-v1.${digest}`
    const now = Date.now()
    this.pruneArrangementRefs(now)
    this.arrangementRefs.set(arrangementRef, {
      viewerUserId,
      arrangementUid,
      expiresAtMillis: now + ARKME_ARRANGEMENT_REF_TTL_MILLIS,
    })
    return arrangementRef
  }

  private async arrangementReminderEvent(
    raw: unknown,
    viewerUserId: number,
  ): Promise<ArkmeArrangementReminderEvent> {
    const item = objectValue(raw)
    const eventUid = stringValue(item.uid).trim()
    const arrangementUid = stringValue(item.arrangement_uid).trim()
    if (eventUid === '' || arrangementUid === '') {
      throw new ArkmePluginError('arrangement-reminder-contract-invalid', '安排提醒响应缺少有效身份', true, 502)
    }
    const dueAtMillis = Math.trunc(numberValue(item.due_at))
    const remindAtMillis = Math.trunc(numberValue(item.remind_at))
    const readAtMillis = Math.trunc(numberValue(item.read_at))
    return {
      eventRef: await this.arrangementReminderRef(viewerUserId, eventUid),
      arrangementRef: await this.arrangementRef(viewerUserId, arrangementUid),
      title: stringValue(item.title),
      description: stringValue(item.description),
      eventKind: stringValue(item.event_kind),
      eventAtMillis: Math.trunc(numberValue(item.event_at)),
      read: readAtMillis > 0,
      reminderState: stringValue(item.reminder_state),
      createdAtMillis: Math.trunc(numberValue(item.create_at)),
      updatedAtMillis: Math.trunc(numberValue(item.update_at)),
      ...(dueAtMillis > 0 ? { dueAtMillis } : {}),
      ...(remindAtMillis > 0 ? { remindAtMillis } : {}),
      ...(readAtMillis > 0 ? { readAtMillis } : {}),
    }
  }

  private async arrangementReminderRef(viewerUserId: number, eventUid: string): Promise<string> {
    const digest = createHmac('sha256', await this.runtime.stateStore.uniqueCode())
      .update(`arrangement-reminder-v1:${String(viewerUserId)}:${eventUid}`)
      .digest('base64url')
    const eventRef = `arkme-arrangement-reminder-v1.${digest}`
    const now = Date.now()
    this.pruneArrangementReminderRefs(now)
    this.arrangementReminderRefs.set(eventRef, {
      viewerUserId,
      eventUid,
      expiresAtMillis: now + ARKME_ARRANGEMENT_REMINDER_REF_TTL_MILLIS,
    })
    return eventRef
  }

  private pruneArrangementReminderRefs(now: number): void {
    for (const [eventRef, entry] of this.arrangementReminderRefs) {
      if (entry.expiresAtMillis <= now) this.arrangementReminderRefs.delete(eventRef)
    }
    while (this.arrangementReminderRefs.size >= MAX_ARKME_ARRANGEMENT_REMINDER_REFS) {
      const oldest = this.arrangementReminderRefs.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.arrangementReminderRefs.delete(oldest)
    }
  }

  private openArrangementReminderRef(eventRef: string, viewerUserId: number): ArkmeArrangementReminderRefEntry {
    const normalized = eventRef.trim()
    const entry = normalized.startsWith('arkme-arrangement-reminder-v1.')
      ? this.arrangementReminderRefs.get(normalized)
      : undefined
    if (entry === undefined || entry.viewerUserId !== viewerUserId || entry.expiresAtMillis <= Date.now()) {
      this.arrangementReminderRefs.delete(normalized)
      throw new ArkmePluginError(
        'arrangement-reminder-ref-invalid',
        '安排提醒引用无效或已过期，请刷新提醒',
        false,
        403,
      )
    }
    return entry
  }

  private pruneArrangementRefs(now: number): void {
    for (const [arrangementRef, entry] of this.arrangementRefs) {
      if (entry.expiresAtMillis <= now) this.arrangementRefs.delete(arrangementRef)
    }
    while (this.arrangementRefs.size >= MAX_ARKME_ARRANGEMENT_REFS) {
      const oldest = this.arrangementRefs.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.arrangementRefs.delete(oldest)
    }
  }

  private openArrangementRef(arrangementRef: string, viewerUserId: number): ArkmeArrangementRefEntry {
    const normalized = arrangementRef.trim()
    const entry = normalized.startsWith('arkme-arrangement-v1.')
      ? this.arrangementRefs.get(normalized)
      : undefined
    if (entry === undefined || entry.viewerUserId !== viewerUserId || entry.expiresAtMillis <= Date.now()) {
      this.arrangementRefs.delete(normalized)
      throw new ArkmePluginError('arrangement-ref-invalid', '安排引用无效或已过期，请刷新安排', false, 403)
    }
    return entry
  }
}
