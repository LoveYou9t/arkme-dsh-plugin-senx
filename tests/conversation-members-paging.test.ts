import { afterEach, expect, it, vi } from 'vitest'
import { ConversationMembersStore } from '../src/client/conversation-members-store.js'
import type { ArkmeConversationMemberItem, ArkmeConversationMemberPage, ArkmeConversationMemberCache } from '../src/types.js'

const { fallback } = vi.hoisted(() => ({ fallback: vi.fn() }))
vi.mock('../src/client/api.js', () => ({ callArkme: fallback }))
const account = 'test:42'
const source = { sourceRef: 'ref', sourceKey: 'group', kind: 'group_chat' as const, displayName: '群' }
const member = (memberRef: string, displayName = memberRef): ArkmeConversationMemberItem => ({
  memberRef, displayName, role: 'member', status: 'active', isSelf: false, isOwner: false, joinedAtMillis: 1, recordCount: 1, mentionCount: 0,
})
const page = (items: ArkmeConversationMemberItem[], cursor?: string): ArkmeConversationMemberPage => ({
  source, items, removedMemberRefs: [], hasMore: cursor !== undefined, presentationComplete: true,
  ...(cursor === undefined ? {} : { nextCursor: cursor }),
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => { vi.useRealTimers() })

it('does not resurrect cached rows after the remote access check has failed', async () => {
  const cached = deferred<ArkmeConversationMemberCache>()
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: () => cached.promise,
    page: async () => { throw Object.assign(new Error('已失去访问权限'), { body: { code: 'arkme-code-1004' } }) },
  })
  store.subscribe(account, source, vi.fn())
  await store.ensure(account, source)
  cached.resolve({ items: [member('a')], joinEvents: [], cachedAtMillis: 1 })
  await Promise.resolve()
  expect(store.get(account, source).items).toEqual([])
  expect(store.get(account, source).error).toBe('已失去访问权限')
  store.activateAccount(undefined)
})

it('clears advisory rows when presentation verification reports revoked access', async () => {
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => ({ items: [member('a')], joinEvents: [], cachedAtMillis: 1 }),
    page: async () => ({ ...page([member('a')]), presentationComplete: false }),
    presentation: async () => { throw Object.assign(new Error('访问权限已失效'), { body: { code: 'arkme-code-1004' } }) },
  })
  store.subscribe(account, source, vi.fn())
  await store.ensure(account, source)
  expect(store.get(account, source).items).toEqual([])
  expect(store.get(account, source).error).toBe('访问权限已失效')
  store.activateAccount(undefined)
})

it('restores disk cache immediately without skipping or waiting to start the remote request', async () => {
  const remote = deferred<ArkmeConversationMemberPage>()
  const loadPage = vi.fn(() => remote.promise)
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => ({ items: [member('a', '缓存名字')], joinEvents: [], cachedAtMillis: Date.now() }),
    page: loadPage,
  })
  store.subscribe(account, source, vi.fn())
  const pending = store.ensure(account, source)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(loadPage).toHaveBeenCalledOnce()
  expect(store.get(account, source)).toMatchObject({ cached: true, refreshing: true, complete: false, items: [{ displayName: '缓存名字' }] })
  remote.resolve(page([member('a', '服务端名字')]))
  await pending
  expect(store.get(account, source)).toMatchObject({ cached: false, complete: true, items: [{ displayName: '服务端名字' }] })
  store.activateAccount(undefined)
})

it('does not let slow cache overwrite newer remote pages', async () => {
  const cache = deferred<ArkmeConversationMemberCache>()
  const store = new ConversationMembersStore(undefined, Date.now, { cached: () => cache.promise, page: async () => page([member('new')]) })
  store.subscribe(account, source, vi.fn())
  await store.ensure(account, source)
  cache.resolve({ items: [member('old')], joinEvents: [], cachedAtMillis: Date.now() })
  await Promise.resolve()
  expect(store.get(account, source).items.map(member => member.memberRef)).toEqual(['new'])
  store.activateAccount(undefined)
})

it('publishes each page and only removes absent cached members after explicit verification', async () => {
  const first = deferred<ArkmeConversationMemberPage>()
  const second = deferred<ArkmeConversationMemberPage>()
  const verify = deferred<ArkmeConversationMemberPage>()
  const presentation = vi.fn(() => verify.promise)
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => ({ items: [member('old')], joinEvents: [], cachedAtMillis: 1 }),
    page: async (_ref, cursor) => await (cursor ? second.promise : first.promise), presentation,
  })
  store.subscribe(account, source, vi.fn())
  const pending = store.ensure(account, source)
  await Promise.resolve(); await Promise.resolve()
  first.resolve(page([member('a')], 'page-2'))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(store.get(account, source).items.map(member => member.memberRef).sort()).toEqual(['a', 'old'])
  expect(presentation).not.toHaveBeenCalled()
  second.resolve(page([member('b')]))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(presentation).toHaveBeenCalledWith('ref', ['old'], expect.any(AbortSignal))
  expect(store.get(account, source).items).toHaveLength(3)
  verify.resolve({ ...page([]), removedMemberRefs: ['old'] })
  await pending
  expect(store.get(account, source).items.map(member => member.memberRef).sort()).toEqual(['a', 'b'])
  store.activateAccount(undefined)
})

it('keeps first-page data on a later-page failure and rejects repeated cursors', async () => {
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => null, page: async () => page([member('a')], 'repeated'),
  })
  store.subscribe(account, source, vi.fn())
  await store.ensure(account, source)
  expect(store.get(account, source)).toMatchObject({ complete: false, ready: true, items: [{ memberRef: 'a' }], error: '成员分页游标重复或缺失，请重试' })
  store.activateAccount(undefined)
})

it('bounds hydration concurrency and makes the basic page visible before profiles complete', async () => {
  const profiles = deferred<ArkmeConversationMemberPage>()
  const hydration = vi.fn(() => profiles.promise)
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => null,
    page: async () => ({ ...page([member('a', '基础名单')]), presentationComplete: false }),
    presentation: hydration,
  })
  store.subscribe(account, source, vi.fn())
  const pending = store.ensure(account, source)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(store.get(account, source).items[0]?.displayName).toBe('基础名单')
  expect(store.get(account, source).refreshing).toBe(true)
  profiles.resolve(page([member('a', '完整资料')]))
  await pending
  expect(store.get(account, source).items[0]?.displayName).toBe('完整资料')
  expect(hydration).toHaveBeenCalledOnce()
  store.activateAccount(undefined)
})

it('preserves cache-first rendering while an older backend falls back to the full query', async () => {
  const remote = deferred<unknown>()
  fallback.mockImplementation(() => remote.promise)
  const store = new ConversationMembersStore(undefined, Date.now, {
    cached: async () => ({ items: [member('a', '缓存')], joinEvents: [], cachedAtMillis: 1 }),
    page: async () => { throw { body: { code: 'member-pagination-unavailable' } } },
  })
  store.subscribe(account, source, vi.fn())
  const pending = store.ensure(account, source)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(fallback).toHaveBeenCalledWith('source.members', { sourceRef: 'ref', activeOnly: true }, expect.any(AbortSignal))
  expect(store.get(account, source).items[0]?.displayName).toBe('缓存')
  remote.resolve({ source, items: [member('a', '远端')], total: 1, activeCount: 1 })
  await pending
  expect(store.get(account, source)).toMatchObject({ complete: true, cached: false, items: [{ displayName: '远端' }] })
  store.activateAccount(undefined)
  fallback.mockReset()
})
