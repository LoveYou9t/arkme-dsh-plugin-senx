import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ArkmeLocalDatabase } from '../src/local-database.js'
import { ArkmeStateStore } from '../src/state-store.js'
import type { ArkmeConversationMemberItem, ArkmeConversationMemberPage } from '../src/types.js'

const member = (memberRef: string, displayName = memberRef): ArkmeConversationMemberItem => ({
  memberRef, displayName, role: 'member', status: 'active', isSelf: false, isOwner: false, joinedAtMillis: 1, recordCount: 9, mentionCount: 1,
})
const page = (items: ArkmeConversationMemberItem[], complete = true): ArkmeConversationMemberPage => ({
  source: { sourceRef: 'ref', sourceKey: 'group', kind: 'group_chat', displayName: '群' }, items,
  removedMemberRefs: [], hasMore: false, presentationComplete: complete,
})

describe('persistent member cache', () => {
  it('survives a database restart in a path with spaces and isolates account/group scopes', async () => {
    const path = await mkdtemp(join(tmpdir(), 'arkme member cache '))
    let db = new ArkmeLocalDatabase(path, new ArkmeStateStore(path))
    try {
      await db.mergeConversationMembers(42, 'group-a', page([member('a', '缓存名字')]))
      await db.mergeConversationMembers(42, 'group-b', page([member('b')]))
      await db.mergeConversationMembers(43, 'group-a', page([member('c')]))
      db.close(); db = new ArkmeLocalDatabase(path, new ArkmeStateStore(path))
      expect((await db.cachedConversationMembers(42, 'group-a'))?.items.map(item => item.displayName)).toEqual(['缓存名字'])
      expect((await db.cachedConversationMembers(42, 'group-b'))?.items.map(item => item.memberRef)).toEqual(['b'])
      expect((await db.cachedConversationMembers(43, 'group-a'))?.items.map(item => item.memberRef)).toEqual(['c'])
      expect(await db.cachedConversationMembers(44, 'group-a')).toBeUndefined()
      await db.clearConversationMembers(42, 'group-a')
      expect(await db.cachedConversationMembers(42, 'group-a')).toBeUndefined()
      expect(await db.cachedConversationMembers(43, 'group-a')).toBeDefined()
    } finally { db.close(); await rm(path, { recursive: true }) }
  })

  it('merges pages without erasing cached presentation and applies only explicit removals', async () => {
    const path = await mkdtemp(join(tmpdir(), 'arkme member cache '))
    const db = new ArkmeLocalDatabase(path, new ArkmeStateStore(path))
    try {
      await db.mergeConversationMembers(42, 'group', page([{ ...member('a', '备注'), avatarRef: 'avatar' }, member('b')]))
      await Promise.all([
        db.mergeConversationMembers(42, 'group', page([{ ...member('a', '群成员'), recordCount: 0 }], false)),
        db.mergeConversationMembers(42, 'group', page([member('c')])),
      ])
      let cache = await db.cachedConversationMembers(42, 'group')
      expect(cache?.items).toHaveLength(3)
      expect(cache?.items.find(item => item.memberRef === 'a')).toMatchObject({ displayName: '备注', recordCount: 9, avatarRef: 'avatar' })
      await db.mergeConversationMembers(42, 'group', { ...page([member('a', '新昵称')]), removedMemberRefs: ['b'] })
      cache = await db.cachedConversationMembers(42, 'group')
      expect(cache?.items.map(item => item.memberRef)).toEqual(['a', 'c'])
      expect(cache?.items[0]?.avatarRef).toBeUndefined()
    } finally { db.close(); await rm(path, { recursive: true }) }
  })

  it('treats corrupt cache as a miss and bounds retained groups', async () => {
    const path = await mkdtemp(join(tmpdir(), 'arkme member cache '))
    const db = new ArkmeLocalDatabase(path, new ArkmeStateStore(path))
    try {
      for (let index = 0; index < 101; index++) await db.mergeConversationMembers(42, String(index), page([member(String(index))]))
      const raw = new DatabaseSync(join(path, 'records.sqlite3'))
      try {
        expect(raw.prepare('SELECT COUNT(*) AS n FROM conversation_member_cache').get()?.n).toBe(100)
        raw.prepare('UPDATE conversation_member_cache SET snapshot_json = ? WHERE group_key = ?').run('{bad json', '100')
        expect(await db.cachedConversationMembers(42, '100')).toBeUndefined()
      } finally { raw.close() }
    } finally { db.close(); await rm(path, { recursive: true }) }
  })
})
