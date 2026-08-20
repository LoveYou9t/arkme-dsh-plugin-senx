import { createHmac } from 'node:crypto'
import type { ArkmeSessionCredentials } from '../keychain-store.js'
import type {
  ArkmeRelatedRecordingEligibility,
  ArkmeRelatedRecordingItem,
  ArkmeRelatedRecordingMonthBucket,
  ArkmeRelatedRecordingPage,
  ArkmeRelatedRecordingPageOptions,
  ArkmeRelatedRecordingPageState,
} from '../types.js'
import { SourceService, type ArkmeSourceRefPayload } from './source-service.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'

export const MAX_ARKME_RELATED_RECORDING_PAGE_SIZE = 20
export const MAX_ARKME_RELATED_RECORDING_CURSOR_LENGTH = 1024
const MAX_ARKME_TIMEZONE_OFFSET_MILLIS = 14 * 60 * 60 * 1000
const RELATED_RECORDINGS_FUNC_TYPE = 17

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function booleanValue(value: unknown): boolean { return value === true }
function listValue(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function optionalPositiveNumber(value: unknown): number | undefined {
  const number = numberValue(value)
  return number > 0 ? number : undefined
}
function optionalString(value: unknown): string | undefined {
  const text = stringValue(value).trim()
  return text === '' ? undefined : text
}

export class RelatedRecordingService {
  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
  ) {}

  isEnabled(): boolean {
    return this.runtime.config.relatedRecordingsEnabled !== false
  }

  async relatedRecordingEligibility(
    sourceRef: string,
    signal?: AbortSignal,
  ): Promise<ArkmeRelatedRecordingEligibility> {
    const session = await this.runtime.requireSession()
    await this.requirePrivateSource(sourceRef, session.userId)
    const allowed = this.relatedRecordingsEnabled()
      && await this.loadRelatedRecordingEligibility(session, signal)
    return { allowed }
  }

  async relatedRecordings(
    sourceRef: string,
    options: ArkmeRelatedRecordingPageOptions = {},
  ): Promise<ArkmeRelatedRecordingPage> {
    const limit = options.limit ?? 10
    const cursor = options.cursor?.trim() ?? ''
    const monthKey = options.monthKey?.trim() ?? ''
    const timezoneOffsetMillis = options.timezoneOffsetMillis ?? 0
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARKME_RELATED_RECORDING_PAGE_SIZE) {
      throw new ArkmePluginError('related-recordings-limit-invalid', '相关录音每页条数必须在 1 到 20 之间', false)
    }
    if (cursor.length > MAX_ARKME_RELATED_RECORDING_CURSOR_LENGTH) {
      throw new ArkmePluginError('related-recordings-cursor-invalid', '相关录音分页游标无效', false)
    }
    if (monthKey !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      throw new ArkmePluginError('related-recordings-month-invalid', '相关录音月份参数无效', false)
    }
    if (!Number.isInteger(timezoneOffsetMillis)
      || Math.abs(timezoneOffsetMillis) > MAX_ARKME_TIMEZONE_OFFSET_MILLIS) {
      throw new ArkmePluginError('related-recordings-timezone-invalid', '相关录音时区参数无效', false)
    }
    const session = await this.runtime.requireSession()
    const source = await this.requirePrivateSource(sourceRef, session.userId)
    if (!this.relatedRecordingsEnabled() || !await this.loadRelatedRecordingEligibility(session, options.signal)) {
      throw new ArkmePluginError('related-recordings-not-allowed', '当前账号暂未开放相关录音能力', false, 403)
    }
    const legacyBody: Record<string, unknown> = {
      chat_session_uid: source.ownerRef,
      page_size: limit,
      ...(cursor === '' ? {} : { cursor }),
    }
    const shouldUseModernContract = options.includeTimeIndex === true || monthKey !== ''
    let raw: Record<string, unknown>
    let legacyTimeIndexFallback = false
    if (shouldUseModernContract) {
      try {
        raw = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
          '/api/v1/chats/records/related-recordings/page',
          {
            ...legacyBody,
            ...(monthKey === '' ? {} : { month_key: monthKey }),
            timezone_offset: timezoneOffsetMillis,
            include_time_index: options.includeTimeIndex === true,
          },
          session,
          options.signal,
        )
      } catch (error) {
        const safeLegacyProbe = error instanceof ArkmePluginError
          && error.code === 'arkme-code-1001'
          && cursor === ''
          && monthKey === ''
          && options.includeTimeIndex === true
        if (!safeLegacyProbe) throw error
        raw = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
          '/api/v1/chats/records/related-recordings/page', legacyBody, session, options.signal,
        )
        legacyTimeIndexFallback = true
      }
    } else {
      raw = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/records/related-recordings/page', legacyBody, session, options.signal,
      )
    }
    return await this.relatedRecordingPage(raw, legacyTimeIndexFallback, session.userId, source.ownerRef)
  }

  recordRelatedRecordingsToolEvent(_event: {
    result: 'success' | 'error'
    durationMs: number
    itemCount?: number
    cursorPresent?: boolean
    transcriptRequested?: boolean
    transcriptTruncated?: boolean
  }): void {
    // Best-effort diagnostic sink. Recording content is deliberately excluded.
  }

  private relatedRecordingsEnabled(): boolean {
    return this.isEnabled()
  }

  private async requirePrivateSource(sourceRef: string, userId: number): Promise<ArkmeSourceRefPayload> {
    const source = await this.source.openSourceRef(sourceRef, userId)
    if (source.kind !== 'private_chat') {
      throw new ArkmePluginError('related-recordings-private-source-required', '相关录音仅支持一对一私聊', false)
    }
    return source
  }

  private async loadRelatedRecordingEligibility(
    session: ArkmeSessionCredentials,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const data = await this.runtime.authenticatedAuthPost<Record<string, unknown>>(
      '/api/v1/auth/able-func', { func_type: RELATED_RECORDINGS_FUNC_TYPE }, session, signal,
    )
    return data.able === true
  }

  private async relatedRecordingPage(
    raw: Record<string, unknown>,
    legacyTimeIndexFallback: boolean,
    userId: number,
    chatSessionUid: string,
  ): Promise<ArkmeRelatedRecordingPage> {
    const items: ArkmeRelatedRecordingItem[] = []
    for (const rawItem of listValue(raw.moment_ls)) {
      const item = await this.relatedRecordingItem(rawItem, userId, chatSessionUid)
      if (item !== undefined) items.push(item)
    }
    const partial = raw.partial === true
    const stateCode = numberValue(raw.state)
    const state: ArkmeRelatedRecordingPageState = partial
      ? items.length > 0 ? 'partial' : 'error'
      : items.length > 0 ? 'success'
        : stateCode === 2 ? 'generating'
          : stateCode === 4 ? 'error'
            : 'empty'
    const nextCursor = stringValue(raw.next_cursor).trim()
    const timeIndexComplete = raw.time_index_complete === true && !legacyTimeIndexFallback
    const monthBuckets: ArkmeRelatedRecordingMonthBucket[] = timeIndexComplete
      ? listValue(raw.month_bucket_ls).flatMap(value => {
          const bucket = objectValue(value)
          const monthKey = stringValue(bucket.month_key).trim()
          const itemCount = numberValue(bucket.item_count)
          return /^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) && Number.isInteger(itemCount) && itemCount >= 0
            ? [{ monthKey, itemCount }]
            : []
        })
      : []
    return {
      state,
      stateCode,
      stateMessage: stringValue(raw.state_msg).trim(),
      hasEntry: raw.has_entry === true,
      items,
      hasMore: raw.has_more === true && nextCursor !== '',
      ...(raw.has_more === true && nextCursor !== '' ? { nextCursor } : {}),
      partial,
      ...(timeIndexComplete ? { monthBuckets } : {}),
      timeIndexComplete,
      legacyTimeIndexFallback,
    }
  }

  private async relatedRecordingItem(
    raw: unknown,
    userId: number,
    chatSessionUid: string,
  ): Promise<ArkmeRelatedRecordingItem | undefined> {
    const item = objectValue(raw)
    const momentId = stringValue(item.moment_id).trim()
    const startAtMillis = numberValue(item.start_at)
    if (momentId === '' || !Number.isSafeInteger(startAtMillis) || startAtMillis <= 0) return undefined
    const transcript = stringValue(item.transcript)
    const speakers = listValue(item.speaker_ls).flatMap(value => {
      const speaker = objectValue(value)
      const speakerId = stringValue(speaker.speaker_id).trim()
      if (speakerId === '') return []
      const refUserId = optionalPositiveNumber(speaker.ref_usr_id)
      const nickname = optionalString(speaker.nick_name)
      return [{ speakerId, ...(refUserId === undefined ? {} : { refUserId }), ...(nickname === undefined ? {} : { nickname }) }]
    })
    const participants = listValue(item.participant_ls).flatMap(value => {
      const participant = objectValue(value)
      const speakerId = stringValue(participant.speaker_id).trim()
      const nickname = optionalString(participant.nick_name)
      const displayName = stringValue(participant.display_name).trim() || nickname || ''
      if (speakerId === '' || displayName === '') return []
      const refUserId = optionalPositiveNumber(participant.ref_usr_id)
      return [{
        speakerId,
        ...(refUserId === undefined ? {} : { refUserId }),
        ...(nickname === undefined ? {} : { nickname }),
        displayName,
        role: numberValue(participant.role),
      }]
    })
    const dateStamp = optionalPositiveNumber(item.date_stamp)
    const timezoneOffsetMillis = numberValue(item.tz_offset)
    return {
      recordingRef: await this.relatedRecordingRef(userId, chatSessionUid, momentId),
      startAtMillis,
      endAtMillis: numberValue(item.end_at),
      ...(dateStamp === undefined ? {} : { dateStamp }),
      ...(Number.isSafeInteger(timezoneOffsetMillis) ? { timezoneOffsetMillis } : {}),
      timeRangeText: stringValue(item.time_range_text).trim(),
      title: stringValue(item.title).trim(),
      summary: stringValue(item.summary).trim(),
      summaryStatus: numberValue(item.summary_status),
      ...(transcript === '' ? {} : { transcript }),
      transcriptAvailable: item.transcript_available === true && transcript !== '',
      speakers,
      participants,
      isSharedByOther: item.is_shared_by_other === true,
    }
  }

  private async relatedRecordingRef(userId: number, chatSessionUid: string, momentId: string): Promise<string> {
    const signature = createHmac('sha256', await this.runtime.stateStore.uniqueCode())
      .update(`related-recording:${userId}:${chatSessionUid}:${momentId}`)
      .digest('base64url')
    return `arkme-related-recording-v1.${signature}`
  }
}
