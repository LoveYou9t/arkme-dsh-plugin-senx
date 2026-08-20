import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSessionStore } from '../src/keychain-store.js'
import {
  ArkmePluginError,
  ServiceRuntime,
  type ArkmeServiceConfig,
  type StateStore,
} from '../src/services/service.js'

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

const sessions: ArkmeSessionStore = {
  async read() { return undefined },
  async write() {},
  async delete() {},
}

function runtimeFixture(
  fetchImpl: typeof fetch,
  sessionStore: ArkmeSessionStore = sessions,
  pendingSessionStore?: ArkmeSessionStore,
): ServiceRuntime {
  return new ServiceRuntime(config, sessionStore, {} as StateStore, fetchImpl, pendingSessionStore)
}

describe('ServiceRuntime', () => {
  it('preserves upstream status and retry-after on HTTP failures', async () => {
    const runtime = runtimeFixture(vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '2' },
    })))

    await expect(runtime.postDirect(
      'https://example.test', '/api/test', {}, undefined, [200],
    )).rejects.toMatchObject({
      code: 'arkme-http-error',
      upstreamStatus: 429,
      retryAfterMillis: 2_000,
    })
  })

  it('passes existing ArkmePluginError through unchanged', async () => {
    const original = new ArkmePluginError('domain-failure', '业务失败', false, 409)
    const runtime = runtimeFixture(vi.fn().mockRejectedValue(original) as typeof fetch)

    await expect(runtime.getDirect(
      'https://example.test', '/api/test', undefined, [200],
    )).rejects.toBe(original)
  })

  it('requires an active session for authenticated services', async () => {
    const runtime = runtimeFixture(vi.fn() as typeof fetch)
    await expect(runtime.requireSession()).rejects.toMatchObject({
      code: 'login-required',
      httpStatus: 401,
    })
  })

  it('refreshes and persists an expired access token', async () => {
    let stored = {
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      userId: 42,
    }
    const sessionStore: ArkmeSessionStore = {
      async read() { return stored },
      async write(session) { stored = session },
      async delete() {},
    }
    const runtime = runtimeFixture(vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { access_token: 'new-access' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })), sessionStore)

    await expect(runtime.refreshAccessToken(stored)).resolves.toMatchObject({ accessToken: 'new-access' })
    expect(stored.accessToken).toBe('new-access')
  })

  it('retries an authenticated request once with a refreshed token', async () => {
    let stored = {
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      userId: 42,
    }
    const sessionStore: ArkmeSessionStore = {
      async read() { return stored },
      async write(session) { stored = session },
      async delete() {},
    }
    const authorizations: string[] = []
    const runtime = runtimeFixture(vi.fn(async (input, init) => {
      const url = String(input)
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      if (url.endsWith('/api/public/v1/auth/new-short')) {
        return new Response(JSON.stringify({ code: 200, data: { access_token: 'new-access' } }), { status: 200 })
      }
      authorizations.push(authorization)
      if (authorization === 'Bearer expired-access') return new Response('', { status: 401 })
      return new Response(JSON.stringify({ code: 200, data: { ok: true } }), { status: 200 })
    }), sessionStore)

    await expect(runtime.authenticatedAuthPost<{ ok: boolean }>('/api/test', {}, stored))
      .resolves.toEqual({ ok: true })
    expect(authorizations).toEqual(['Bearer expired-access', 'Bearer new-access'])
  })

  it('fails explicitly when the extension service is disabled', async () => {
    const runtime = runtimeFixture(vi.fn() as typeof fetch)
    await expect(runtime.extensionPost('/api/test', {})).rejects.toMatchObject({
      code: 'extension-service-disabled',
      httpStatus: 503,
    })
  })
})
