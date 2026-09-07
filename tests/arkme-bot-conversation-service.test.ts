import { describe, expect, it } from 'vitest'
import { ArkmeService, type ArkmeServiceConfig } from '../src/arkme-service.js'
import type { ArkmeSessionCredentials } from '../src/keychain-store.js'

class SessionStore {
  constructor(private session: ArkmeSessionCredentials | undefined) {}
  async read() { return this.session }
  async write(session: ArkmeSessionCredentials) { this.session = session }
  async delete() { this.session = undefined }
}

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890',
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('BotConversationService', () => {
  it('keeps every Chat-owned operation on the canonical Chat source instead of the private Bot surface', async () => {
    const calls: string[] = []
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-conversation-device' } } as never,
      async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [{
          bot_id: 'bot-chat-1', name: 'Chat Bot', provider: 'openclaw', status: 'online',
          subject_uid: '', chat_session_uid: 'chat-session-1', direct_chat_owner: 'jotmo-chat',
        }] } })
        throw new Error(`unexpected request ${url}`)
      },
    )
    const bot = (await service.listBots()).items[0]!

    for (const operation of [
      () => service.openBotPrivateChat(bot.botRef),
      () => service.refreshBotPrivateChat(bot.botRef),
      () => service.sendBotPrivateChatMessage(bot.botRef, 'hello'),
      () => service.botNotificationPreference(bot.botRef),
      () => service.updateBotNotificationPreference(bot.botRef, true),
      () => service.markBotPrivateChatRead(bot.botRef, 7),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'bot-conversation-standard-chat-required', retryable: false,
      })
    }
    expect(calls).toEqual(['https://bot.test/api/v1/bot/list'])
  })

  it('keeps the private Bot directory Subject-only without per-item conversation reads', async () => {
    const calls: string[] = []
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-directory-device' } } as never,
      async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [
          {
            bot_id: 'bot-chat-directory', name: 'Chat Bot', provider: 'openclaw', status: 'online',
            subject_uid: '', chat_session_uid: 'chat-session-directory', direct_chat_owner: 'jotmo-chat',
          },
          {
            bot_id: 'bot-subject-directory', name: 'Subject Bot', provider: 'openclaw', status: 'online',
            subject_uid: 'subject-directory', chat_session_uid: '', direct_chat_owner: 'jotmo-subject',
            latest_activity_at: 1788100000456,
          },
        ] } })
        throw new Error(`unexpected request ${url}`)
      },
    )

    await expect(service.listBotPrivateChatDirectory()).resolves.toMatchObject({
      items: [{
        name: 'Subject Bot', conversationProjection: 'record', conversationListActivityAtMillis: 1788100000456,
      }],
    })
    expect(calls).toEqual(['https://bot.test/api/v1/bot/list'])
  })

  it('keeps Subject-owned Bot conversation reads on the Subject adapter', async () => {
    const calls: string[] = []
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-conversation-device' } } as never,
      async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [{
          bot_id: 'bot-subject-1', name: 'Subject Bot', provider: 'openclaw', status: 'online',
          subject_uid: 'subject-1', chat_session_uid: '', direct_chat_owner: 'jotmo-subject',
        }] } })
        if (url.endsWith('/api/v1/bot/private-chat/open')) return json({ code: 200, data: { messages: [] } })
        throw new Error(`unexpected request ${url}`)
      },
    )
    const bot = (await service.listBots()).items[0]!

    await expect(service.openBotPrivateChat(bot.botRef)).resolves.toEqual({ messages: [] })
    await expect(service.markBotPrivateChatRead(bot.botRef, 1)).rejects.toMatchObject({
      code: 'bot-conversation-read-unsupported',
    })
    expect(calls).toEqual([
      'https://bot.test/api/v1/bot/list',
      'https://bot.test/api/v1/bot/private-chat/open',
    ])
  })
  it('projects Subject-owned Bot actions only for stable messages with canonical Record identity', async () => {
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-conversation-device' } } as never,
      async (input, init) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [{
          bot_id: 'bot-subject-1', name: 'Subject Bot', provider: 'openclaw', status: 'online',
          subject_uid: 'subject-1', chat_session_uid: '',
        }] } })
        if (url.endsWith('/api/v1/bot/private-chat/open')) return json({ code: 200, data: {
          messages: [
            { message_id: 'record-stable', role: 'assistant', content: '稳定回复', status: 'sent', created_at: 1_786_000_000 },
            { message_id: 'record-user', role: 'user', content: '我的问题', status: 'sent', created_at: 1_786_000_000 },
            { message_id: 'record-pending', role: 'assistant', content: '流式中', status: 'pending', created_at: 1_786_000_001 },
          ],
        } })
        if (url.endsWith('/api/v1/chats/messages/copy-link/get-or-create')) {
          expect(body).toEqual({ sources: [{ kind: 'record', record_owner_user_id: 42, record_uid: 'record-user' }] })
          return json({ code: 200, data: { sid: 'sid-subject', url: 'https://jotmo.example/s/sid-subject' } })
        }
        throw new Error(`unexpected request ${url}`)
      },
    )
    const bot = (await service.listBots()).items[0]!
    const conversation = await service.openBotPrivateChat(bot.botRef)

    expect(conversation.messages[0]).toMatchObject({
      recordUid: 'record-stable', messageActionRef: expect.any(String),
      messageActionCapabilities: { copyLink: false, forward: true },
    })
    expect(conversation.messages[1]).toMatchObject({
      recordUid: 'record-user', messageActionRef: expect.any(String),
      messageActionCapabilities: { copyLink: true, forward: true },
    })
    expect(conversation.messages[2]?.messageActionRef).toBeUndefined()
    await expect(service.copyMessageActionsLink(bot.botRef, [conversation.messages[1]?.messageActionRef ?? '']))
      .resolves.toMatchObject({ sid: 'sid-subject' })
  })


  it('does not reinterpret a Subject Bot reply occurrence id as a Record identity', async () => {
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-conversation-device' } } as never,
      async input => {
        const url = String(input)
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [{
          bot_id: 'bot-subject-1', name: 'Subject Bot', provider: 'openclaw', status: 'online',
          subject_uid: 'subject-1', chat_session_uid: '',
        }] } })
        if (url.endsWith('/api/v1/bot/private-chat/message/send')) return json({ code: 200, data: {
          user_message: { message_id: 'user-record-uid', role: 'user', content: '问题', status: 'sent', created_at: 1_786_000_000 },
          bot_messages: [
            { message_id: 'reply-occurrence-only', role: 'assistant', content: '尚无 Record 身份', status: 'completed', created_at: 1_786_000_001 },
            { message_id: 'reply-record-uid', record_uid: 'reply-record-uid', role: 'assistant', content: '已落 Record', status: 'completed', created_at: 1_786_000_002 },
          ],
          status: 'ok',
        } })
        throw new Error(`unexpected request ${url}`)
      },
    )
    const bot = (await service.listBots()).items[0]!
    const result = await service.sendBotPrivateChatMessage(bot.botRef, '问题')

    expect(result.userMessage).toMatchObject({ recordUid: 'user-record-uid', messageActionRef: expect.any(String) })
    expect(result.botMessages[0]).toMatchObject({ messageId: 'reply-occurrence-only' })
    expect(result.botMessages[0]?.recordUid).toBeUndefined()
    expect(result.botMessages[0]?.messageActionRef).toBeUndefined()
    expect(result.botMessages[1]).toMatchObject({
      recordUid: 'reply-record-uid', messageActionRef: expect.any(String),
      messageActionCapabilities: { copyLink: false, forward: true },
    })
  })


  it('does not fabricate read acknowledgement support for a Subject-owned Bot', async () => {
    const calls: string[] = []
    const service = new ArkmeService(
      config,
      new SessionStore({ userId: 42, accessToken: 'access', refreshToken: 'refresh' }),
      { async uniqueCode() { return 'bot-conversation-device' } } as never,
      async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/bot/list')) return json({ code: 200, data: { bots: [{
          bot_id: 'bot-subject-1', name: 'Subject Bot', provider: 'openclaw', status: 'online',
          subject_uid: 'subject-1', chat_session_uid: '',
        }] } })
        throw new Error(`unexpected request ${url}`)
      },
    )
    const bot = (await service.listBots()).items[0]!

    await expect(service.markBotPrivateChatRead(bot.botRef, 1)).rejects.toMatchObject({
      code: 'bot-conversation-read-unsupported',
    })
    expect(calls.filter(url => !url.endsWith('/api/v1/bot/list'))).toEqual([])
  })

})
