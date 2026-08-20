import { describe, expect, it } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import { MediaService } from '../../src/services/media-service.js'
import { ProfileService } from '../../src/services/profile-service.js'
import { RecordService } from '../../src/services/record-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'
import { WorldService } from '../../src/services/world-service.js'

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890', interwovenMomentsEnabled: true,
}

describe('WorldService', () => {
  it('projects the public world list without authentication', async () => {
    const sessions: ArkmeSessionStore = { async read() { return undefined }, async write() {}, async delete() {} }
    const state = { async uniqueCode() { return 'device-secret' } } as StateStore
    const fetchImpl = async () => new Response(JSON.stringify({ code: 200, data: {
      list: [{ nick_name: '小明', headline: '标题', text_content: '正文', created_at: 1 }], total: 1,
    } }), { status: 200 })
    const runtime = new ServiceRuntime(config, sessions, state, fetchImpl)
    const profile = new ProfileService(runtime)
    let world!: WorldService
    const media = new MediaService(runtime, profile, {
      async openWorldImageRef(imageRef, viewerUserId) { return await world.openWorldImageRef(imageRef, viewerUserId) },
    }, { recordUid() { return '' } })
    const record = new RecordService(runtime, media, { async openSourceRef() { throw new Error('unexpected') } })
    world = new WorldService(runtime, profile, media, record)

    await expect(world.listWorldRecords()).resolves.toMatchObject({
      items: [{ authorName: '小明', headline: '标题', textContent: '正文' }], total: 1,
    })
  })
})
