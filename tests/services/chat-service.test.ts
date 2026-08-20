import { describe, expect, it } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import { ArkoService } from '../../src/services/arko-service.js'
import { BotService } from '../../src/services/bot-service.js'
import { ChatService } from '../../src/services/chat-service.js'
import { GroupAiPolishService } from '../../src/services/group-ai-polish-service.js'
import { MediaService } from '../../src/services/media-service.js'
import { ProfileService } from '../../src/services/profile-service.js'
import { RecordService } from '../../src/services/record-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'
import { SourceService } from '../../src/services/source-service.js'

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890', interwovenMomentsEnabled: true,
}

describe('ChatService', () => {
  it('rejects opening a private chat with the current user', async () => {
    const sessions: ArkmeSessionStore = {
      async read() { return { userId: 42, accessToken: 'access', refreshToken: 'refresh' } },
      async write() {}, async delete() {},
    }
    const runtime = new ServiceRuntime(config, sessions, { async uniqueCode() { return 'device-secret' } } as StateStore)
    const profile = new ProfileService(runtime)
    const source = new SourceService(runtime, profile, {
      async summary() { return { recordCount: 0, wordsCount: 0, totalSec: 0 } }, recordItem() { return undefined },
    })
    const media = new MediaService(runtime, profile, { async openWorldImageRef() { throw new Error('unused') } }, {
      recordUid() { return '' },
    })
    const record = new RecordService(runtime, media, source)
    const bot = new BotService(runtime, source)
    const arko = new ArkoService(runtime, profile)
    let chat!: ChatService
    const polish = new GroupAiPolishService(runtime, source, {
      async sendChatSourceTextRaw(...args) { return await chat.sendChatSourceTextRaw(...args) },
    })
    chat = new ChatService(runtime, source, profile, media, record, bot, arko, polish, {
      emitChatClientEvent() {}, nextChatClientRevision() { return 1 }, scheduleChatSessionProjection() {},
    })

    await expect(chat.openPrivateChatFromUser(42)).rejects.toMatchObject({ code: 'private-chat-self-invalid' })
  })
})
