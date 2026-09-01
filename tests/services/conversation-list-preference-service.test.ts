import { describe, expect, it, vi } from 'vitest'
import type { ArkmeSessionStore } from '../../src/keychain-store.js'
import {
  BOT_DIRECT_CONVERSATION_LIST_ENTITY,
  CHAT_SESSION_CONVERSATION_LIST_ENTITY,
  ConversationListPreferenceService,
  type ConversationListPreferenceRef,
} from '../../src/services/conversation-list-preference-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'

const config: ArkmeServiceConfig = {
  environment: 'test', authBaseUrl: 'https://auth.test', subjectBaseUrl: 'https://subject.test',
  recordBaseUrl: 'https://record.test', chatBaseUrl: 'https://chat.test', botBaseUrl: 'https://bot.test',
  imBaseUrl: 'https://im.test', webrtcBaseUrl: 'https://webrtc.test', worldBaseUrl: 'https://world.test',
  relationBaseUrl: 'https://relation.test', intelligentBaseUrl: 'https://intelligent.test',
  routePath: '/arkme-self/api', audioBaseUrl: 'https://audio.test', requestTimeoutMs: 5_000,
  maxTextLength: 20_000, geetestCaptchaId: 'captcha-test-id-1234567890', interwovenMomentsEnabled: true,
}

const sessionStore: ArkmeSessionStore = {
  async read() { return { userId: 42, accessToken: 'access', refreshToken: 'refresh' } },
  async write() {}, async delete() {},
}

const ref: ConversationListPreferenceRef = {
  entityKind: CHAT_SESSION_CONVERSATION_LIST_ENTITY,
  entityUid: 'chat-1',
}

describe('ConversationListPreferenceService', () => {
  it('consumes the current owner query contract without runtime feature flags', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const service = createService(async (path, body) => {
      requests.push({ path, body })
      return { items: [snapshot(1, 'chat-1', 2, 3, 100, 7)] }
    })

    await expect(service.query([ref], { ownerUserId: 42 })).resolves.toEqual([
      expect.objectContaining({
        ref,
        visibilityState: 2,
        dismissedThroughSequence: 7,
        dismissedThroughActivityAtMillis: 100,
        revision: 3,
      }),
    ])
    expect(requests).toEqual([{
      path: '/api/v1/conversation-list/preferences/query',
      body: { entry_refs: [{ entity_kind: 1, entity_uid: 'chat-1' }] },
    }])
  })

  it('keeps equal raw UIDs in different entity kinds independent', async () => {
    const service = createService(async () => ({
      items: [
        snapshot(1, 'same', 2, 3, 100, 7),
        snapshot(2, 'same', 1, 0, 0, 0),
      ],
    }))

    const result = await service.query([
      { entityKind: 1, entityUid: 'same' },
      { entityKind: 2, entityUid: 'same' },
    ], { ownerUserId: 42 })

    expect(result.map(item => `${String(item.ref.entityKind)}:${item.ref.entityUid}`))
      .toEqual(['1:same', '2:same'])
  })

  it('dismisses with owner CAS and treats only accepted outcomes as success', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const service = createService(async (path, body) => {
      requests.push({ path, body })
      if (path.endsWith('/query')) return { items: [snapshot(1, 'chat-1', 1, 0, 0, 0)] }
      return { items: [{ outcome: 1, ...snapshot(1, 'chat-1', 2, 1, 100, 7) }] }
    })

    await service.query([ref], { ownerUserId: 42 })
    await expect(service.dismiss(ref, {
      sequence: 7,
      activityAtMillis: 100,
    }, { ownerUserId: 42 })).resolves.toMatchObject({ visibilityState: 2, revision: 1 })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({
      path: '/api/v1/conversation-list/preferences/set',
      body: { items: [{
        entity_kind: 1,
        entity_uid: 'chat-1',
        target_visibility_state: 2,
        expected_revision: 0,
        observed_seq: 7,
        observed_activity_at: 100,
      }] },
    })

    const conflict = createService(async path => path.endsWith('/query')
      ? { items: [snapshot(1, 'chat-1', 1, 2, 0, 0)] }
      : { items: [{ outcome: 3, ...snapshot(1, 'chat-1', 1, 3, 0, 0) }] })
    await expect(conflict.dismiss(ref, {
      sequence: 7,
      activityAtMillis: 100,
    }, { ownerUserId: 42 })).rejects.toMatchObject({ code: 'conversation-list-preference-conflict' })
  })

  it('rejects Chat sequence evidence for a direct Bot before owner I/O', async () => {
    const owner = vi.fn(async () => ({}))
    const service = createService(owner)

    await expect(service.dismiss({
      entityKind: BOT_DIRECT_CONVERSATION_LIST_ENTITY,
      entityUid: 'bot-1',
    }, {
      sequence: 1,
      activityAtMillis: 100,
    }, { ownerUserId: 42 })).rejects.toMatchObject({
      code: 'conversation-list-preference-evidence-invalid',
    })
    expect(owner).not.toHaveBeenCalled()
  })

  it('accepts an idempotent dismissal only when the owner snapshot covers the same evidence', async () => {
    const service = createService(async path => path.endsWith('/query')
      ? { items: [snapshot(1, 'chat-1', 2, 4, 100, 7)] }
      : { items: [{ outcome: 2, ...snapshot(1, 'chat-1', 2, 4, 100, 7) }] })

    await expect(service.dismiss(ref, {
      sequence: 7,
      activityAtMillis: 100,
    }, { ownerUserId: 42 })).resolves.toMatchObject({
      visibilityState: 2,
      dismissedThroughSequence: 7,
      dismissedThroughActivityAtMillis: 100,
      revision: 4,
    })
  })

  it('restores an already-visible row without an unnecessary owner write', async () => {
    const requests: string[] = []
    const service = createService(async path => {
      requests.push(path)
      return { items: [snapshot(1, 'chat-1', 1, 4, 0, 0)] }
    })

    await expect(service.restore([ref], { ownerUserId: 42 })).resolves.toBeUndefined()
    expect(requests).toEqual(['/api/v1/conversation-list/preferences/query'])
  })

  it('rejects a typed ref resolved for another account before owner I/O', async () => {
    const owner = vi.fn(async () => ({}))
    const service = createService(owner)

    await expect(service.query([ref], { ownerUserId: 99 }))
      .rejects.toMatchObject({ code: 'login-context-changed' })
    expect(owner).not.toHaveBeenCalled()
  })
})

function createService(
  response: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
): ConversationListPreferenceService {
  const fetchImpl = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({ code: 200, data: await response(path, body) }), { status: 200 })
  }) as typeof fetch
  return new ConversationListPreferenceService(new ServiceRuntime(
    config,
    sessionStore,
    { async uniqueCode() { return 'device-secret' } } as StateStore,
    fetchImpl,
  ))
}

function snapshot(
  entityKind: number,
  entityUid: string,
  visibilityState: number,
  revision: number,
  activityAt: number,
  sequence: number,
): Record<string, unknown> {
  return {
    entity_kind: entityKind,
    entity_uid: entityUid,
    visibility_state: visibilityState,
    dismissed_through_seq: sequence,
    dismissed_through_activity_at: activityAt,
    revision,
    updated_at: revision === 0 ? 0 : 110,
  }
}
