import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'
import { WechatService } from '../../src/services/wechat-service.js'

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890', interwovenMomentsEnabled: true,
}

describe('WechatService', () => {
  it('projects conversations with account-bound refs', async () => {
    const sessions: ArkmeSessionStore = {
      async read() { return { userId: 42, accessToken: 'access', refreshToken: 'refresh' } },
      async write() {}, async delete() {},
    }
    const stateStore = { async uniqueCode() { return 'device-secret' } } as StateStore
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 200, data: {
      conversations: [{ import_session_key: 'wx-1', name: '项目群', ext_is_group: true, message_count: 9 }],
      total: 1, has_more: false,
    } }), { status: 200 })) as typeof fetch
    const service = new WechatService(new ServiceRuntime(config, sessions, stateStore, fetchImpl))

    await expect(service.listWechatConversations()).resolves.toMatchObject({
      conversations: [{
        name: '项目群', isGroup: true, messageCount: 9,
        conversationRef: expect.stringMatching(/^arkme-wechat-conversation-v1\./),
      }],
      total: 1,
      hasMore: false,
    })
  })
})
