import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import { AiVideoService } from '../../src/services/ai-video-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'

const config: ArkmeServiceConfig = {
  environment: 'test',
  authBaseUrl: 'https://auth.test',
  subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test',
  chatBaseUrl: 'https://chat.test',
  botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test',
  webrtcBaseUrl: 'https://webrtc.test',
  worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test',
  intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api',
  audioBaseUrl: 'https://audio.test',
  requestTimeoutMs: 5_000,
  maxTextLength: 20_000,
  geetestCaptchaId: 'captcha-test-id-1234567890',
  interwovenMomentsEnabled: true,
}

describe('AiVideoService', () => {
  it('projects a completed video job through the intelligent owner', async () => {
    const sessions: ArkmeSessionStore = {
      async read() { return { userId: 42, accessToken: 'access', refreshToken: 'refresh' } },
      async write() {},
      async delete() {},
    }
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://intelligent.test/api/v1/ai-comic-video/jobs/status')
      return new Response(JSON.stringify({ code: 200, data: {
        job_id: 'job-1', status: 'succeeded', stage: 'succeeded', progress: 100,
        selection: { segments: [{}] }, video_asset_uid: 'video-1',
      } }), { status: 200 })
    }) as typeof fetch
    const service = new AiVideoService(new ServiceRuntime(config, sessions, {} as StateStore, fetchImpl))

    await expect(service.aiVideoStatus('job-1')).resolves.toMatchObject({
      jobId: 'job-1', status: 'succeeded', progress: 100,
      selectedSegmentCount: 1, videoAssetUid: 'video-1',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
