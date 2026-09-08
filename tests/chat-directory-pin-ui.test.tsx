import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkmeSourceItem } from '../src/types.js'

const mocks = vi.hoisted(() => ({ callArkme: vi.fn() }))
vi.mock('../src/client/api.js', () => ({ callArkme: mocks.callArkme, ArkmeClientError: class extends Error {} }))
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/client/ArkmeNotificationPermissionBanner.js', () => ({ ArkmeNotificationPermissionBanner: () => null }))
vi.mock('../src/client/ArkmeDSHBetaCommunityEntry.js', () => ({
  ArkmeDSHBetaCommunityEntry: () => null, ArkmeDSHBetaCommunityEntryContent: () => null,
}))
vi.mock('../src/client/arko-conversation-preview-sync.js', () => ({
  ArkmeArkoConversationPreviewSync: class { start() { return () => undefined } },
}))

import { ArkmeNavigation } from '../src/client/ArkmeVirtualWorkspace.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeChatDirectory } from '../src/client/chat-directory-store.js'
import { arkmeUi } from '../src/client/ui-controller.js'

const source: ArkmeSourceItem = {
  sourceRef: 'chat-ref', sourceKey: 'chat-key', kind: 'private_chat', displayName: '置顶目标',
  isPinned: false, unreadCount: 0, activeAtMillis: 100,
}
let renderer: ReactTestRenderer | undefined
let resolvePin: (value: unknown) => void
let rejectPin: (reason: unknown) => void

function row() {
  return renderer!.root.findAllByProps({ role: 'treeitem' }).find(node => node.props['aria-label'] === source.displayName)!
}
function menu() { return renderer!.root.findAllByProps({ role: 'menuitem' })[0]! }
function pinCalls() { return mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.directory.policy.set') }
async function openMenu() {
  await act(async () => { row().props.onContextMenu({ preventDefault() {}, clientX: 20, clientY: 20 }) })
}
async function startPin() {
  await openMenu()
  await act(async () => { menu().props.onClick() })
}

beforeEach(async () => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1200, innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: vi.fn(), setTimeout, clearTimeout,
  })
  vi.stubGlobal('document', {
    body: {}, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })
  mocks.callArkme.mockReset()
  mocks.callArkme.mockImplementation(async (operation: string) => {
    if (operation === 'sources.list') return { directory: 'root', items: [source], hasMore: false }
    if (operation === 'bots.private-chat.directory') return { items: [] }
    if (operation === 'source.directory.policy.set') {
      return await new Promise((resolve, reject) => { resolvePin = resolve; rejectPin = reject })
    }
    if (operation === 'chat.official-author.profile' || operation === 'arko.profile') throw new Error('not needed')
    return {}
  })
  arkmeChatDirectory.activateAccount('test:pin-ui')
  arkmeChatDirectory.publish([source])
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7001 })
  arkmeUi.selectSource(source)
  await act(async () => { renderer = create(<ArkmeNavigation />) })
})
afterEach(async () => {
  await act(async () => { renderer?.unmount() })
  renderer = undefined
  arkmeChatDirectory.activateAccount(undefined)
  arkmeAuthStore.setAuth({ status: 'logged-out', environment: 'test' })
  arkmeUi.showLogin()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('conversation pin interaction', () => {
  it('shows pending feedback, prevents reentry, then offers unpin after success', async () => {
    await startPin()
    expect(pinCalls()).toHaveLength(1)
    expect(pinCalls()[0]?.[1]).toEqual({ sourceRef: 'chat-ref', pinned: true })
    expect(row().props.disabled).toBe(true)
    expect(row().props['aria-busy']).toBe(true)
    await openMenu()
    expect(renderer!.root.findAllByProps({ role: 'menuitem' })).toHaveLength(0)
    expect(pinCalls()).toHaveLength(1)
    await act(async () => { resolvePin({ sourceRef: 'chat-ref', pinned: true, policyUpdatedAtMillis: 2000 }) })
    expect(row().props.disabled).toBe(false)
    expect(renderer!.root.findByProps({ role: 'status' }).children).toEqual(['已置顶对话'])
    await openMenu()
    expect(menu().children).toEqual(['取消置顶'])
    await act(async () => { menu().props.onClick() })
    expect(pinCalls()[1]?.[1]).toEqual({ sourceRef: 'chat-ref', pinned: false })
    await act(async () => { resolvePin({ sourceRef: 'chat-ref', pinned: false, policyUpdatedAtMillis: 3000 }) })
    await openMenu()
    expect(menu().children).toEqual(['置顶对话'])
  })

  it('restores the original state and allows retry after an owner rejection', async () => {
    await startPin()
    await act(async () => { rejectPin(new Error('没有会话权限')) })
    expect(row().props.disabled).toBe(false)
    expect(renderer!.root.findByProps({ role: 'status' }).children).toEqual(['没有会话权限'])
    await openMenu()
    expect(menu().children).toEqual(['置顶对话'])
    await act(async () => { menu().props.onClick() })
    expect(pinCalls()).toHaveLength(2)
    await act(async () => { resolvePin({ sourceRef: 'chat-ref', pinned: true, policyUpdatedAtMillis: 2000 }) })
  })

  it.each(['success', 'failure'] as const)('preserves new messages and rotated refs during pin %s', async outcome => {
    await startPin()
    expect(arkmeChatDirectory.getSnapshot().sources.find(item => item.sourceKey === source.sourceKey)?.isPinned).toBe(false)
    const latest = { ...source, sourceRef: 'rotated-chat-ref', unreadCount: 8, latestPreview: '刚收到的新消息' }
    const other = { ...source, sourceKey: 'other-key', sourceRef: 'other-ref', displayName: '新会话' }
    await act(async () => { arkmeChatDirectory.publish([latest, other]) })
    await act(async () => {
      if (outcome === 'success') resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 })
      else rejectPin(new Error('置顶失败'))
    })
    expect(arkmeChatDirectory.getSnapshot().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: source.sourceKey, sourceRef: 'rotated-chat-ref', unreadCount: 8, latestPreview: '刚收到的新消息', isPinned: outcome === 'success' }),
      expect.objectContaining({ sourceKey: 'other-key', displayName: '新会话' }),
    ]))
  })

  it.each(['success', 'failure'] as const)('keeps the self workspace usable while pin finishes with %s', async outcome => {
    await startPin()
    const selfRow = renderer!.root.findAllByProps({ role: 'treeitem' }).find(node =>
      node.findAll(child => child.type === 'span' && child.children.includes('发给自己')).length > 0,
    )!
    expect(selfRow.props.disabled).not.toBe(true)
    await act(async () => { selfRow.props.onClick() })
    expect(arkmeUi.getSnapshot()).toMatchObject({ mode: 'source' })
    expect(arkmeUi.getSnapshot().selectedSource).toBeUndefined()
    await act(async () => {
      if (outcome === 'success') resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 })
      else rejectPin(new Error('置顶失败'))
    })
    expect(arkmeUi.getSnapshot().selectedSource).toBeUndefined()
    expect(row().props.disabled).toBe(false)
    expect(arkmeChatDirectory.getSnapshot().sources).toEqual([
      expect.objectContaining({ sourceKey: source.sourceKey, isPinned: outcome === 'success' }),
    ])
  })

  it('does not let an older directory refresh undo a confirmed pin', async () => {
    let releasePage!: (value: unknown) => void
    mocks.callArkme.mockImplementationOnce(async () => await new Promise(resolve => { releasePage = resolve }))
    let refresh!: Promise<ArkmeSourceItem[]>
    await act(async () => { refresh = arkmeChatDirectory.refreshRoot({ force: true }) })
    await startPin()
    await act(async () => { resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 }) })
    expect(arkmeChatDirectory.getSnapshot().sources[0]?.isPinned).toBe(true)
    await act(async () => {
      releasePage({ directory: 'root', items: [source], hasMore: false })
      await refresh
    })
    expect(arkmeChatDirectory.getSnapshot().sources[0]?.isPinned).toBe(true)
    await openMenu()
    expect(menu().children).toEqual(['取消置顶'])
  })

  it('does not resurrect a removed conversation when pin finishes', async () => {
    await startPin()
    await act(async () => { arkmeChatDirectory.publish([]) })
    await act(async () => { resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 }) })
    expect(arkmeChatDirectory.getSnapshot().sources).toEqual([])
  })

  it('keeps a newer cross-device unpin when the local pin acknowledgement arrives later', async () => {
    await startPin()
    await act(async () => { arkmeChatDirectory.publish([{ ...source, isPinned: false, chatPolicyUpdatedAtMillis: 3000 }]) })
    await act(async () => { resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 }) })
    expect(row().props.disabled).toBe(false)
    await openMenu()
    expect(menu().children).toEqual(['置顶对话'])
    expect(pinCalls()).toHaveLength(1)
  })

  it('keeps another conversation navigable while pinning', async () => {
    const other = { ...source, sourceKey: 'other-key', sourceRef: 'other-ref', displayName: '其他会话' }
    await act(async () => { arkmeChatDirectory.publish([source, other]) })
    await startPin()
    const otherRow = renderer!.root.findAllByProps({ role: 'treeitem' }).find(node => node.props['aria-label'] === other.displayName)!
    expect(otherRow.props.disabled).not.toBe(true)
    await act(async () => { otherRow.props.onClick() })
    expect(arkmeUi.getSnapshot().selectedSource?.sourceKey).toBe(other.sourceKey)
    await act(async () => { resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 }) })
    expect(arkmeUi.getSnapshot().selectedSource?.sourceKey).toBe(other.sourceKey)
  })

  it.each(['success', 'failure'] as const)('does not apply the old account %s after switching accounts', async outcome => {
    await startPin()
    await act(async () => { arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7002 }) })
    const before = arkmeChatDirectory.getSnapshot().sources
    await act(async () => {
      if (outcome === 'success') resolvePin({ sourceRef: source.sourceRef, pinned: true, policyUpdatedAtMillis: 2000 })
      else rejectPin(new Error('旧账号的错误'))
    })
    expect(arkmeChatDirectory.getSnapshot().sources).toEqual(before)
    const statuses = renderer!.root.findAllByProps({ role: 'status' }).flatMap(node => node.children)
    expect(statuses).not.toContain('旧账号的错误')
    expect(statuses).not.toContain('已置顶对话')
  })
})
