import { describe, expect, it } from 'vitest'
import {
  arkmeChatDeltaCalendarDateStamps, arkmeChatDeltaSourceKeys,
  arkmeSelectedBotAffectedByChatDelta,
} from '../src/client/realtime-client-events.js'
import type { ArkmeBotSummary, ArkmeChatClientEvent } from '../src/types.js'

const selectedBot: ArkmeBotSummary = {
  botRef: 'bot-ref', name: 'Chat Bot', provider: 'webhook', description: '', status: 'online',
  directChatAvailable: true, privateChatOutboundEnabled: true, conversationProjection: 'chat',
  chatSourceKey: 'selected-chat-key',
}
const delta: Extract<ArkmeChatClientEvent, { type: 'sessions-delta' }> = {
  type: 'sessions-delta', revision: 1,
  updates: [{
    sourceKey: 'selected-chat-key',
    source: { sourceRef: 'source-ref', sourceKey: 'selected-chat-key', kind: 'private_chat', displayName: 'Chat', activeAtMillis: 1, unreadCount: 1 },
    timelineItems: [],
  }],
}

describe('Chat-owned Bot realtime invalidation', () => {
  it('matches only an exact opaque source key for the currently selected Chat Bot', () => {
    expect(arkmeSelectedBotAffectedByChatDelta(selectedBot, delta)).toBe(true)
    expect(arkmeSelectedBotAffectedByChatDelta(
      { ...selectedBot, chatSourceKey: 'other-key' }, delta,
    )).toBe(false)
    expect(arkmeSelectedBotAffectedByChatDelta(
      { ...selectedBot, conversationProjection: 'record', chatSourceKey: undefined }, delta,
    )).toBe(false)
    expect(arkmeSelectedBotAffectedByChatDelta(undefined, delta)).toBe(false)
  })

  it('does not infer identity from source refs or missing keys', () => {
    expect(arkmeSelectedBotAffectedByChatDelta(selectedBot, {
      ...delta,
      updates: [{ ...delta.updates[0]!, sourceKey: undefined, source: { ...delta.updates[0]!.source, sourceRef: 'selected-chat-key', sourceKey: undefined } }],
    })).toBe(false)
    expect(arkmeSelectedBotAffectedByChatDelta(selectedBot, {
      ...delta,
      updates: [{ ...delta.updates[0]!, source: { ...delta.updates[0]!.source, kind: 'group_chat' } }],
    })).toBe(false)
  })

  it('derives the exact scoped invalidation keys carried by a sessions delta', () => {
    expect(arkmeChatDeltaSourceKeys({
      ...delta,
      updates: [
        delta.updates[0]!,
        { ...delta.updates[0]!, sourceKey: 'other-key', source: { ...delta.updates[0]!.source, sourceKey: 'stale-key' } },
        delta.updates[0]!,
      ],
    })).toEqual(['selected-chat-key', 'other-key'])
  })

  it('derives Calendar dates from authoritative source and timeline timestamps', () => {
    expect(arkmeChatDeltaCalendarDateStamps({
      ...delta,
      updates: [{
        ...delta.updates[0]!,
        source: { ...delta.updates[0]!.source, activeAtMillis: 100 },
        timelineItems: [{
          itemUid: 'message-1', senderName: '联系人', isMe: false, sendAtMillis: 200,
          title: '', textContent: '消息', status: 1, sequence: 1,
        }, {
          itemUid: 'message-2', senderName: '联系人', isMe: false, sendAtMillis: 200,
          title: '', textContent: '重复日期提示', status: 1, sequence: 2,
        }],
      }],
    })).toEqual([100, 200])
  })
})
