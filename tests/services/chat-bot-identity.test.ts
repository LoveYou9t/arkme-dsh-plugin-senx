import { describe, expect, it, vi } from 'vitest'
import { ArkmeStaleRequestError } from '../../src/request-coordinator.js'
import { ChatService } from '../../src/services/chat-service.js'
import { MediaService } from '../../src/services/media-service.js'
import { ProfileService } from '../../src/services/profile-service.js'
import { ServiceRuntime, type ArkmeServiceConfig, type StateStore } from '../../src/services/service.js'

function fixture() {
  const session = { userId: 42, accessToken: 'access', refreshToken: 'refresh' }
  let started!: () => void
  const snapshotStarted = new Promise<void>(resolve => { started = resolve })
  let snapshotSignal: AbortSignal | undefined
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/api/v1/chat/timeline/page')) return new Response(JSON.stringify({ code: 200, data: {
      items: [{ relation: { record_uid: 'record', sender_actor_kind: 2, sender_bot_uid: 'bot', sender_user_id: 9001 },
        record: { status: 1, payload: { text_content: 'visible reply' } } }],
    } }))
    if (!String(url).endsWith('/api/v1/chats/display-snapshots')) throw new Error(`unexpected request: ${String(url)}`)
    snapshotSignal = init?.signal ?? undefined
    return await new Promise<Response>((resolve, reject) => {
      finish = resolve
      snapshotSignal?.addEventListener('abort', () => reject(snapshotSignal?.reason), { once: true })
      started()
    })
  })
  const runtime = new ServiceRuntime({
    environment: 'test', chatBaseUrl: 'https://chat.test', authBaseUrl: 'https://auth.test', requestTimeoutMs: 30_000,
  } as ArkmeServiceConfig, {
    read: async () => session, write: async () => {}, delete: async () => {},
  }, { uniqueCode: async () => 'signing-key' } as StateStore, fetchImpl)
  const profile = new ProfileService(runtime)
  const chat = new ChatService(runtime,
    { openSourceRef: async () => ({ kind: 'group_chat', ownerRef: 'chat' }), sourceItem: async () => ({ kind: 'group_chat' }) } as never,
    profile, new MediaService(runtime, profile, {} as never, { recordUid: () => 'record' }),
    {} as never, {} as never, {} as never, { timelineAiPolish: () => undefined } as never, {} as never)
  return { runtime, chat, fetchImpl, snapshotStarted, snapshotSignal: () => snapshotSignal,
    finish: (response: Response) => finish(response),
    read: (signal?: AbortSignal) => chat.readSource('source', { cursor: { beforeSequence: 1 }, ...(signal ? { signal } : {}) }),
  }
}

describe('Bot identity through ServiceRuntime', () => {
  it('bounds optional hydration, cancels the HTTP request and still returns message content', async () => {
    const timeout = new AbortController()
    const caller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const f = fixture()
    const pending = f.read(caller.signal)
    try {
      await f.snapshotStarted
      expect(timeoutSpy).toHaveBeenCalledWith(1_500)
      timeout.abort(new DOMException('decoration timeout', 'TimeoutError'))
      expect((await pending).items[0]).toMatchObject({ senderName: 'Bot', textContent: 'visible reply' })
      expect(f.snapshotSignal()?.aborted).toBe(true)
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      caller.abort()
      await pending.catch(() => {})
      timeoutSpy.mockRestore()
    }
  })

  it('propagates account invalidation instead of returning stale message projections', async () => {
    const f = fixture()
    const pending = f.read()
    const rejected = expect(pending).rejects.toBeInstanceOf(ArkmeStaleRequestError)
    await f.snapshotStarted
    f.runtime.requestCoordinator.invalidateScope('user:42')
    await rejected
    expect(f.snapshotSignal()?.aborted).toBe(true)
  })

  it('does not refresh login credentials for optional Bot decoration', async () => {
    const f = fixture()
    const refresh = vi.spyOn(f.runtime, 'refreshAccessToken')
    const pending = f.read()
    await f.snapshotStarted
    f.finish(new Response('{}', { status: 401 }))
    expect((await pending).items[0]).toMatchObject({ senderName: 'Bot', textContent: 'visible reply' })
    expect(refresh).not.toHaveBeenCalled()
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps a shared participant request alive when only one timeline reader cancels', async () => {
    const f = fixture()
    const request = vi.spyOn(f.runtime, 'authenticatedChatPost')
    const firstCaller = new AbortController()
    const first = f.read(firstCaller.signal)
    const reason = new Error('first reader closed')
    const firstRejected = expect(first).rejects.toBe(reason)
    const second = f.read()
    await f.snapshotStarted
    await vi.waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/api/v1/chats/display-snapshots')).toHaveLength(2))
    firstCaller.abort(reason)
    await firstRejected
    expect(f.snapshotSignal()?.aborted).toBe(false)
    f.finish(new Response(JSON.stringify({ code: 200, data: { items: [{
      session: { chat_session_uid: 'chat' },
      bot_participants: [{ chat_session_uid: 'chat', bot_uid: 'bot', display_name_snapshot: 'Group Bot' }],
    }] } })))
    expect((await second).items[0]?.senderName).toBe('Group Bot')
    expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/chats/display-snapshots'))).toHaveLength(1)
  })
})
