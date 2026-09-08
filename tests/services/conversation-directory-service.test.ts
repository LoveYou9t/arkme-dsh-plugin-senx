import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationDirectoryService, mergeDirectorySource } from '../../src/services/conversation-directory-service.js'
import type { ServiceRuntime } from '../../src/services/service.js'
import type { SourceService } from '../../src/services/source-service.js'
import type { ConversationDirectoryVisibilityService } from '../../src/services/conversation-directory-visibility-service.js'
import type { ArkmeSourceItem, ArkmeSourceList } from '../../src/types.js'

function gate<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const row = (id: number, extra: Partial<ArkmeSourceItem> = {}): ArkmeSourceItem => ({ sourceRef: `ref-${id}`, sourceKey: `key-${id}`, kind: 'private_chat', displayName: `Chat ${id}`, activeAtMillis: id, unreadCount: 0, latestSequence: id, ...extra })
const page = (items: ArkmeSourceItem[], nextCursor?: string): ArkmeSourceList => ({ directory: 'root', items, hasMore: nextCursor !== undefined, ...(nextCursor === undefined ? {} : { nextCursor }) })
const owners: ConversationDirectoryService[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.reset() })
function setup(load: (cursor?: string) => Promise<ArkmeSourceList>, cached?: ArkmeSourceList) {
  let userId = 1
  const write = vi.fn(async () => undefined)
  const emitted: ArkmeSourceList[] = []
  const source = { listSources: vi.fn(async (_directory, options) => { expect(options.limit).toBe(20); return await load(options.cursor) }),
    openSourceRef: vi.fn(async () => ({ userId })), hydrateDirectoryPage: vi.fn(async (items: ArkmeSourceItem[]) => items) }
  const preferences = { query: vi.fn(async (refs: string[]) => ({ items: refs.map(entryRef => ({ entryKind: 'source' as const, entryRef, hidden: false })) })) }
  const runtime = { requireSession: async () => ({ userId }), accountScopedSession: async () => ({ userId }), stateStore: { readDirectoryCache: async () => cached, writeDirectoryCache: write } }
  const owner = new ConversationDirectoryService(runtime as unknown as ServiceRuntime, source as unknown as SourceService, preferences as unknown as ConversationDirectoryVisibilityService, async () => ({ items: [] }), async () => undefined, value => { emitted.push(value) })
  owners.push(owner)
  return { owner, source, write, emitted, preferences, switchUser: (id: number) => { userId = id; owner.reset() } }
}

describe('local-first directory', () => {
  it('publishes the first twenty rows before slow page two, avatars, or disk', async () => {
    const next = gate<ArkmeSourceList>(); const avatar = gate<ArkmeSourceItem[]>(); const disk = gate<void>()
    const test = setup(async cursor => cursor === undefined ? page(Array.from({ length: 20 }, (_, i) => row(i)), 'next') : next.promise)
    test.source.hydrateDirectoryPage.mockImplementation(() => avatar.promise)
    test.write.mockImplementation(() => disk.promise)
    const first = await test.owner.read()
    expect(first.items).toHaveLength(20)
    expect(first.projection?.phase).toBe('syncing')
    next.resolve(page([row(21)])); avatar.resolve([]); disk.resolve()
    await test.owner.settled()
    expect((await test.owner.read()).items).toHaveLength(21)
  })

  it('restores the entire local list with pins and hidden state before remote resolves', async () => {
    const remote = gate<ArkmeSourceList>()
    const cached = { ...page([row(1, { isPinned: true, avatarRef: 'local-avatar' }), row(2)]), projection: { revision: 8, phase: 'cached' as const, cachedAtMillis: 1, bots: [], visibility: [{ entryKind: 'source' as const, entryRef: 'ref-2', hidden: true }] } }
    const test = setup(() => remote.promise, cached)
    expect(await test.owner.read()).toMatchObject({ items: cached.items, projection: { visibility: cached.projection.visibility, bots: [] } })
    remote.resolve(page([row(3)])); await test.owner.settled()
    expect((await test.owner.read()).items.map(item => item.sourceRef)).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  it('automatically drains more than ten twenty-row pages without user input', async () => {
    const test = setup(async cursor => { const index = Number(cursor ?? 0); return page(Array.from({ length: 20 }, (_, offset) => row(index * 20 + offset)), index < 11 ? String(index + 1) : undefined) })
    await test.owner.read(); await test.owner.settled()
    expect(test.source.listSources).toHaveBeenCalledTimes(12)
    expect((await test.owner.read()).items).toHaveLength(240)
  })

  it('joins notification and browser reads in one scan', async () => {
    const remote = gate<ArkmeSourceList>(); const test = setup(() => remote.promise)
    const baseline = test.owner.complete(); const first = test.owner.read()
    remote.resolve(page([row(1)])); await Promise.all([baseline, first])
    expect(test.source.listSources).toHaveBeenCalledTimes(1)
  })

  it('keeps first-page rows on background failure and rejects a repeated cursor', async () => {
    const test = setup(async cursor => cursor === undefined ? page([row(1)], 'same') : page([row(2)], 'same'))
    await test.owner.read()
    await expect(test.owner.settled()).rejects.toThrow('游标')
    expect(test.emitted.at(-1)?.projection?.phase).toBe('failed')
    expect(test.emitted.flatMap(value => value.items)).toContainEqual(row(1))
  })

  it('never publishes an old account page after reset', async () => {
    const remote = gate<ArkmeSourceList>(); const test = setup(() => remote.promise)
    const first = test.owner.read(); await vi.waitFor(() => expect(test.source.listSources).toHaveBeenCalledTimes(1))
    test.switchUser(2); remote.resolve(page([row(1)]))
    await expect(first).rejects.toThrow()
    expect(test.emitted).toEqual([])
  })

  it('merges message and pin versions independently and preserves unknown avatar fields', () => {
    const local = row(1, { latestSequence: 8, latestPreview: 'new', isPinned: true, chatPolicyUpdatedAtMillis: 20, avatarRef: 'cached' })
    expect(mergeDirectorySource(local, row(1, { latestSequence: 7, latestPreview: 'old', isPinned: false, chatPolicyUpdatedAtMillis: 21 }))).toMatchObject({ latestSequence: 8, latestPreview: 'new', isPinned: false, avatarRef: 'cached' })
    expect(mergeDirectorySource(local, row(1, { latestSequence: 9, isPinned: false, chatPolicyUpdatedAtMillis: 19 }))).toMatchObject({ latestSequence: 9, isPinned: true })
  })
  it('uses the retained newer signed activity when reconciling a stale page dismissal', async () => {
    const current = row(1, { sourceRef: 'newer-ref', latestSequence: 10, activeAtMillis: 10 })
    const cached = { ...page([current]), projection: { revision: 3, phase: 'cached' as const, cachedAtMillis: 1, bots: [], visibility: [] } }
    const test = setup(async () => page([row(1, { sourceRef: 'older-ref', latestSequence: 5, activeAtMillis: 5 })]), cached)
    await test.owner.read(); await test.owner.settled()
    expect(test.preferences.query).toHaveBeenCalledWith(['newer-ref'], [], expect.any(AbortSignal))
    expect((await test.owner.read()).items[0]).toMatchObject({ sourceRef: 'newer-ref', latestSequence: 10 })
  })

  it('retains a cached Bot absent from a refresh until explicit deletion', async () => {
    const bot = { botRef: 'cached-bot', directoryKey: 'bot-key', name: 'Saved Bot' }
    const cached = { ...page([row(1)]), projection: { revision: 1, phase: 'cached' as const, cachedAtMillis: 1, visibility: [], bots: [bot] } } as ArkmeSourceList
    const test = setup(async () => page([row(1)]), cached)
    await test.owner.read(); await test.owner.settled()
    expect((await test.owner.read()).projection?.bots).toHaveLength(1)
    await test.owner.forgetBot('cached-bot')
    expect((await test.owner.read()).projection?.bots).toHaveLength(0)
  })

})
