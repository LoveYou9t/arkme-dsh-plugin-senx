import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  ArkmeWechatCallFilter,
  ArkmeWechatCommonGroupPage,
  ArkmeWechatConversationDetail,
  ArkmeWechatConversationPage,
  ArkmeWechatGroupMember,
  ArkmeWechatGroupMemberPage,
  ArkmeWechatLocation,
  ArkmeWechatLocationPage,
  ArkmeWechatMessage,
  ArkmeWechatMessageFilter,
  ArkmeWechatMessagePage,
  ArkmeWechatMoneyFlow,
  ArkmeWechatMoneyFlowPage,
  ArkmeWechatPhonePage,
} from '../types.js'
import { ArkmePluginError, ServiceRuntime, clippedText, objectValue, stringValue } from './service.js'

interface ArkmeWechatConversationRefPayload {
  version: 1
  userId: number
  importSessionKey: string
}

interface ArkmeWechatCursorPayload {
  version: 1
  userId: number
  scope: string
  offset: number
}

const WECHAT_MESSAGE_TYPES: Readonly<Record<number, string>> = {
  0: 'text', 1: 'image', 2: 'voice', 3: 'video', 5: 'emoji', 8: 'location',
  23: 'call', 25: 'reply', 49: 'chat_record', 81: 'location_share', 99: 'money_flow',
}

const WECHAT_FILTER_TYPES: Readonly<Record<Exclude<ArkmeWechatMessageFilter, 'all'>, number>> = {
  image: 1, voice: 2, video: 3, emoji: 5, location: 8,
  call: 23, reply: 25, chat_record: 49, location_share: 81,
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const number = numberValue(value)
  return number > 0 ? number : undefined
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value).trim()
  return text === '' ? undefined : text
}

function encodeOpaqueJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeOpaqueJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

export class WechatService {
  constructor(private readonly runtime: ServiceRuntime) {}

  async listWechatConversations(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatConversationPage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 30)))
    const scope = 'conversations'
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-conversations/list',
      { limit, offset, include_bound: true },
      session,
      options.signal,
    )
    const conversations = []
    for (const raw of listValue(data.conversations)) {
      const item = objectValue(raw)
      const importSessionKey = stringValue(item.import_session_key).trim()
      if (importSessionKey === '') continue
      const remark = optionalString(item.remark)
      const nickname = optionalString(item.nickname)
      conversations.push({
        conversationRef: await this.sealWechatConversationRef(session.userId, importSessionKey),
        name: optionalString(item.name) ?? remark ?? nickname ?? '未命名微信会话',
        ...(remark === undefined ? {} : { remark }),
        ...(nickname === undefined ? {} : { nickname }),
        isGroup: booleanValue(item.ext_is_group),
        messageCount: numberValue(item.message_count),
        lastSendAtMillis: numberValue(item.last_send_at),
        isBound: numberValue(item.bound_rm_subject_id) > 0
          || stringValue(item.bound_chat_session_uid).trim() !== '',
      })
    }
    const hasMore = data.has_more === true
    const nextOffset = numberValue(data.next_offset) || offset + conversations.length
    return {
      conversations,
      total: numberValue(data.total),
      hasMore,
      ...(hasMore && nextOffset > offset
        ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) }
        : {}),
    }
  }

  async readWechatMessages(
    conversationRef: string,
    options: {
      limit?: number
      cursor?: string
      messageType?: ArkmeWechatMessageFilter
      callType?: ArkmeWechatCallFilter
      signal?: AbortSignal
    } = {},
  ): Promise<ArkmeWechatMessagePage> {
    const session = await this.runtime.requireSession()
    const conversation = await this.openWechatConversationRef(conversationRef, session.userId)
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 30)))
    const messageType = options.messageType ?? 'all'
    const callType = options.callType ?? 'all'
    if (callType !== 'all' && messageType !== 'call') {
      throw new ArkmePluginError('wechat-call-filter-invalid', '微信通话类型只能与通话消息筛选一起使用', false)
    }
    const scope = `messages:${conversation.importSessionKey}:${messageType}:${callType}`
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const msgType = messageType === 'all' ? undefined : WECHAT_FILTER_TYPES[messageType]
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-conversation-records/list',
      {
        import_session_key: conversation.importSessionKey,
        limit,
        offset,
        ...(msgType === undefined ? {} : { msg_type: msgType }),
        ...(callType === 'all' ? {} : { call_type: callType }),
      },
      session,
      options.signal,
    )
    const messages = listValue(data.records).map(raw => this.wechatMessage(raw))
    const hasMore = data.has_more === true
    const nextOffset = numberValue(data.next_offset) || offset + messages.length
    return {
      conversationRef,
      messages,
      total: numberValue(data.total),
      hasMore,
      ...(hasMore && nextOffset > offset
        ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) }
        : {}),
    }
  }

  async getWechatConversationDetail(
    conversationRef: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatConversationDetail> {
    const session = await this.runtime.requireSession()
    const conversation = await this.openWechatConversationRef(conversationRef, session.userId)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-conversation-detail',
      { import_session_key: conversation.importSessionKey },
      session,
      options.signal,
    )
    const remark = optionalString(data.remark)
    const nickname = optionalString(data.nickname)
    const wechatAlias = optionalString(data.wechat_alias)
    const wechatId = optionalString(data.wechat_id)
    const groupOwnerName = optionalString(data.group_owner_name)
    const firstSendAtMillis = optionalPositiveNumber(data.first_send_at)
    const lastSendAtMillis = optionalPositiveNumber(data.last_send_at)
    const importedAtMillis = optionalPositiveNumber(data.imported_at)
    const commonGroupCount = optionalPositiveNumber(data.common_group_count)
    const groupMemberCount = optionalPositiveNumber(data.group_member_count)
    const groupCommonFriendCount = optionalPositiveNumber(data.group_common_friend_count)
    return {
      conversationRef,
      name: optionalString(data.name) ?? remark ?? nickname ?? '未命名微信会话',
      ...(remark === undefined ? {} : { remark }),
      ...(nickname === undefined ? {} : { nickname }),
      isGroup: booleanValue(data.ext_is_group),
      ...(wechatAlias === undefined ? {} : { wechatAlias }),
      ...(wechatId === undefined ? {} : { wechatId }),
      messageCount: numberValue(data.message_count),
      voiceCount: numberValue(data.voice_count),
      imageCount: numberValue(data.image_count),
      emojiCount: numberValue(data.emoji_count),
      videoCount: numberValue(data.video_count),
      ...(firstSendAtMillis === undefined ? {} : { firstSendAtMillis }),
      ...(lastSendAtMillis === undefined ? {} : { lastSendAtMillis }),
      ...(importedAtMillis === undefined ? {} : { importedAtMillis }),
      ...(commonGroupCount === undefined ? {} : { commonGroupCount }),
      ...(groupOwnerName === undefined ? {} : { groupOwnerName }),
      ...(groupMemberCount === undefined ? {} : { groupMemberCount }),
      ...(groupCommonFriendCount === undefined ? {} : { groupCommonFriendCount }),
    }
  }

  async listWechatGroupMembers(
    conversationRef: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatGroupMemberPage> {
    const session = await this.runtime.requireSession()
    const conversation = await this.openWechatConversationRef(conversationRef, session.userId)
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)))
    const scope = `group-members:${conversation.importSessionKey}`
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-group-members/list',
      { import_session_key: conversation.importSessionKey },
      session,
      options.signal,
    )
    const members = [
      ...listValue(data.members).map(raw => this.wechatGroupMember(raw, true)),
      ...listValue(data.inactive_speakers).map(raw => this.wechatGroupMember(raw, false)),
    ]
    const page = members.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const hasMore = nextOffset < members.length
    return {
      conversationRef,
      members: page,
      total: numberValue(data.total_speakers) || members.length,
      hasMore,
      ...(hasMore ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) } : {}),
    }
  }

  async listWechatPhones(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatPhonePage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    const scope = 'phones'
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-phones/list',
      { limit, offset },
      session,
      options.signal,
    )
    const phones = listValue(data.phones).map(raw => {
      const item = objectValue(raw)
      const likelyOwner = optionalString(item.likely_owner)
      const reason = optionalString(clippedText(item.reason, 500))
      const registeredNickname = optionalString(item.registered_nick_name)
      const location = optionalString(item.phone_location_label)
      const taskStatus = optionalString(item.task_status)
      const evidence = listValue(item.evidence).slice(0, 2).map(rawEvidence => {
        const value = objectValue(rawEvidence)
        const why = optionalString(clippedText(value.why, 200))
        const content = optionalString(clippedText(value.content, 500))
        const sentAtMillis = optionalPositiveNumber(value.send_at)
        return {
          ...(why === undefined ? {} : { why }),
          ...(content === undefined ? {} : { content }),
          ...(sentAtMillis === undefined ? {} : { sentAtMillis }),
        }
      })
      return {
        phone: stringValue(item.phone).trim(),
        ...(likelyOwner === undefined ? {} : { likelyOwner }),
        ...(typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? { confidence: item.confidence }
          : {}),
        ...(reason === undefined ? {} : { reason }),
        occurrenceCount: numberValue(item.record_count),
        lastSeenAtMillis: numberValue(item.last_send_at),
        evidence,
        isRegistered: booleanValue(item.is_registered),
        ...(registeredNickname === undefined ? {} : { registeredNickname }),
        ...(location === undefined ? {} : { location }),
        ...(taskStatus === undefined ? {} : { taskStatus }),
      }
    }).filter(item => item.phone !== '')
    const hasMore = data.has_more === true
    const nextOffset = numberValue(data.next_offset) || offset + phones.length
    return {
      phones,
      total: numberValue(data.total),
      hasMore,
      ...(hasMore && nextOffset > offset
        ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) }
        : {}),
    }
  }

  async listWechatCommonGroups(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatCommonGroupPage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    const scope = 'common-groups'
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-common-groups/list',
      { limit, offset },
      session,
      options.signal,
    )
    const friends = []
    for (const raw of listValue(data.friends)) {
      const item = objectValue(raw)
      const sampleConversationRefs = await Promise.all(listValue(item.sample_group_keys)
        .map(key => stringValue(key).trim())
        .filter(key => key !== '')
        .map(key => this.sealWechatConversationRef(session.userId, key)))
      const lastSendAtMillis = optionalPositiveNumber(item.last_send_at)
      friends.push({
        name: optionalString(item.name) ?? '未命名微信联系人',
        commonGroupCount: numberValue(item.common_group_count),
        ...(lastSendAtMillis === undefined ? {} : { lastSendAtMillis }),
        sampleConversationRefs,
      })
    }
    const hasMore = data.has_more === true
    const nextOffset = numberValue(data.next_offset) || offset + friends.length
    return {
      friends,
      total: numberValue(data.total),
      hasMore,
      ...(hasMore && nextOffset > offset
        ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) }
        : {}),
    }
  }

  async listWechatMoneyFlows(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatMoneyFlowPage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
    const scope = 'money-flows'
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-money-flows/list',
      { limit, offset },
      session,
      options.signal,
    )
    const moneyFlows: ArkmeWechatMoneyFlow[] = []
    for (const raw of listValue(data.records)) {
      const item = objectValue(raw)
      const importSessionKey = stringValue(item.import_session_key).trim()
      moneyFlows.push({
        ...(importSessionKey === '' ? {} : {
          conversationRef: await this.sealWechatConversationRef(session.userId, importSessionKey),
        }),
        content: clippedText(item.content, 1_500),
        senderName: optionalString(item.sender_display_name) ?? (booleanValue(item.sender_is_self) ? '我' : '未知发送者'),
        isMe: booleanValue(item.sender_is_self),
        sentAtMillis: numberValue(item.send_at ?? item.created_at),
      })
    }
    const hasMore = data.has_more === true
    const nextOffset = numberValue(data.next_offset) || offset + moneyFlows.length
    return {
      moneyFlows,
      total: numberValue(data.total),
      hasMore,
      ...(hasMore && nextOffset > offset
        ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) }
        : {}),
    }
  }

  async listWechatLocations(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ArkmeWechatLocationPage> {
    const session = await this.runtime.requireSession()
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)))
    const scope = 'locations'
    const offset = await this.wechatOffset(options.cursor, session.userId, scope)
    const data = await this.runtime.authenticatedRelationPost<Record<string, unknown>>(
      '/api/v1/entity/wechat-import-location-entries',
      {},
      session,
      options.signal,
    )
    const locations: ArkmeWechatLocation[] = []
    for (const raw of listValue(data.entry_ls)) {
      const item = objectValue(raw)
      const conversation = objectValue(item.conversation)
      const importSessionKey = stringValue(item.import_session_key ?? conversation.import_session_key).trim()
      const poiName = optionalString(item.poi_name)
      const address = optionalString(item.address)
      const senderName = optionalString(item.sender_display_name)
      const sentAtMillis = optionalPositiveNumber(item.send_at)
      locations.push({
        ...(importSessionKey === '' ? {} : {
          conversationRef: await this.sealWechatConversationRef(session.userId, importSessionKey),
        }),
        conversationName: optionalString(conversation.name) ?? '未命名微信会话',
        entryType: optionalString(item.entry_type) ?? 'location',
        latitude: numberValue(item.lat),
        longitude: numberValue(item.lon),
        ...(poiName === undefined ? {} : { poiName }),
        ...(address === undefined ? {} : { address }),
        ...(senderName === undefined ? {} : { senderName }),
        isMe: booleanValue(item.sender_is_self),
        ...(sentAtMillis === undefined ? {} : { sentAtMillis }),
      })
    }
    const page = locations.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    const hasMore = nextOffset < locations.length
    return {
      locations: page,
      total: locations.length,
      hasMore,
      ...(hasMore ? { nextCursor: await this.sealWechatCursor(session.userId, scope, nextOffset) } : {}),
    }
  }

  private wechatMessage(raw: unknown): ArkmeWechatMessage {
    const item = objectValue(raw)
    const msgType = numberValue(item.msg_type)
    const mediaDuration = optionalPositiveNumber(item.media_duration)
    const mimeType = optionalString(item.mime_type)
    const isMe = booleanValue(item.sender_is_self)
    return {
      content: clippedText(item.content, 1_500),
      senderName: optionalString(item.sender_display_name) ?? (isMe ? '我' : '未知发送者'),
      isMe,
      sentAtMillis: numberValue(item.send_at ?? item.created_at),
      messageType: WECHAT_MESSAGE_TYPES[msgType] ?? `other_${String(msgType)}`,
      hasMedia: stringValue(item.oss_key).trim() !== '' || stringValue(item.media_path).trim() !== '',
      ...(mediaDuration === undefined ? {} : { mediaDuration }),
      ...(mimeType === undefined ? {} : { mimeType }),
    }
  }

  private wechatGroupMember(raw: unknown, defaultIsInGroup: boolean): ArkmeWechatGroupMember {
    const item = objectValue(raw)
    const lastSendAtMillis = optionalPositiveNumber(item.last_send_at)
    return {
      name: optionalString(item.name) ?? '未命名群成员',
      messageCount: numberValue(item.message_count),
      ...(lastSendAtMillis === undefined ? {} : { lastSendAtMillis }),
      isOwner: booleanValue(item.is_owner),
      isFriend: booleanValue(item.is_friend),
      isMe: booleanValue(item.is_self),
      isInGroup: item.is_in_group === undefined ? defaultIsInGroup : booleanValue(item.is_in_group),
    }
  }

  private async sealWechatConversationRef(userId: number, importSessionKey: string): Promise<string> {
    const payload = encodeOpaqueJson({ version: 1, userId, importSessionKey } satisfies ArkmeWechatConversationRefPayload)
    const signature = createHmac('sha256', await this.runtime.stateStore.uniqueCode()).update(payload).digest('base64url')
    return `arkme-wechat-conversation-v1.${payload}.${signature}`
  }

  private async openWechatConversationRef(
    conversationRef: string,
    expectedUserId: number,
  ): Promise<ArkmeWechatConversationRefPayload> {
    const parts = conversationRef.trim().split('.')
    if (parts.length !== 3 || parts[0] !== 'arkme-wechat-conversation-v1') {
      throw new ArkmePluginError('wechat-conversation-ref-invalid', '微信会话引用无效，请先重新查询微信会话列表', false)
    }
    const payload = parts[1] ?? ''
    const supplied = Buffer.from(parts[2] ?? '', 'base64url')
    const expected = createHmac('sha256', await this.runtime.stateStore.uniqueCode()).update(payload).digest()
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ArkmePluginError('wechat-conversation-ref-invalid', '微信会话引用无效，请先重新查询微信会话列表', false)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = objectValue(decodeOpaqueJson(payload))
    } catch (error) {
      throw new ArkmePluginError(
        'wechat-conversation-ref-invalid',
        '微信会话引用无效，请先重新查询微信会话列表',
        false,
        400,
        { cause: error },
      )
    }
    const result: ArkmeWechatConversationRefPayload = {
      version: 1,
      userId: numberValue(parsed.userId),
      importSessionKey: stringValue(parsed.importSessionKey).trim(),
    }
    if (parsed.version !== 1 || result.userId !== expectedUserId || result.importSessionKey === '') {
      throw new ArkmePluginError('wechat-conversation-ref-invalid', '微信会话引用与当前账号不匹配', false, 403)
    }
    return result
  }

  private async sealWechatCursor(userId: number, scope: string, offset: number): Promise<string> {
    const payload = encodeOpaqueJson({ version: 1, userId, scope, offset } satisfies ArkmeWechatCursorPayload)
    const signature = createHmac('sha256', await this.runtime.stateStore.uniqueCode()).update(payload).digest('base64url')
    return `arkme-wechat-cursor-v1.${payload}.${signature}`
  }

  private async wechatOffset(cursor: string | undefined, expectedUserId: number, expectedScope: string): Promise<number> {
    if (cursor === undefined || cursor.trim() === '') return 0
    const parts = cursor.trim().split('.')
    if (parts.length !== 3 || parts[0] !== 'arkme-wechat-cursor-v1') {
      throw new ArkmePluginError('wechat-cursor-invalid', '微信数据分页游标无效，请从第一页重新查询', false)
    }
    const payload = parts[1] ?? ''
    const supplied = Buffer.from(parts[2] ?? '', 'base64url')
    const expected = createHmac('sha256', await this.runtime.stateStore.uniqueCode()).update(payload).digest()
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ArkmePluginError('wechat-cursor-invalid', '微信数据分页游标无效，请从第一页重新查询', false)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = objectValue(decodeOpaqueJson(payload))
    } catch (error) {
      throw new ArkmePluginError(
        'wechat-cursor-invalid',
        '微信数据分页游标无效，请从第一页重新查询',
        false,
        400,
        { cause: error },
      )
    }
    const result: ArkmeWechatCursorPayload = {
      version: 1,
      userId: numberValue(parsed.userId),
      scope: stringValue(parsed.scope),
      offset: numberValue(parsed.offset),
    }
    if (parsed.version !== 1 || result.userId !== expectedUserId || result.scope !== expectedScope
      || !Number.isSafeInteger(result.offset) || result.offset < 0) {
      throw new ArkmePluginError('wechat-cursor-invalid', '微信数据分页游标与当前查询不匹配', false, 403)
    }
    return result.offset
  }
}
