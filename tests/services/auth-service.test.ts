import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import { AuthService } from '../../src/services/auth-service.js'
import { ProfileService } from '../../src/services/profile-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890', interwovenMomentsEnabled: true,
}

describe('AuthService', () => {
  it('reports a logged-out state without touching upstream services', async () => {
    const sessions: ArkmeSessionStore = {
      async read() { return undefined }, async write() {}, async delete() {},
    }
    const fetchImpl = vi.fn() as typeof fetch
    const runtime = new ServiceRuntime(config, sessions, {} as StateStore, fetchImpl)
    const service = new AuthService(runtime, new ProfileService(runtime), {
      reconnectChatRealtime() {}, clearAccountState() {},
    })

    await expect(service.authStatus()).resolves.toEqual({ status: 'logged-out', environment: 'test' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
