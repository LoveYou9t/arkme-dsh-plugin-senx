import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkmeSourceItem, ArkmeTimelineItem } from '../src/types.js'

const mocks = vi.hoisted(() => ({ callArkme: vi.fn() }))
vi.mock('../src/client/api.js', () => ({
  callArkme: mocks.callArkme,
  ArkmeClientError: class extends Error {
    constructor(readonly body: { code: string; message: string; retryable: boolean }) { super(body.message) }
  },
}))
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))

import { ArkmeSurface } from '../src/client/ArkmeSidebar.js'
import { ArkmeAttachmentStrip } from '../src/client/ArkmeAttachmentStrip.js'
import { ArkmeConfirmDialog } from '../src/client/ArkmeConfirmDialog.js'
import { ArkmeClientError } from '../src/client/api.js'
import { ArkmeRichComposerInput } from '../src/client/ArkmeRichComposerInput.js'
import { ArkmeMediaPreview } from '../src/client/ArkmeRichContent.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeChatDirectory, arkmeChatTimelineDelta } from '../src/client/chat-directory-store.js'
import { arkmeComposerDraftStore, arkmeSourceComposerDraftKey } from '../src/client/composer-draft-store.js'
import { arkmeMessageReadReceipts } from '../src/client/message-read-receipt-store.js'
import { arkmeUi } from '../src/client/ui-controller.js'

const source: ArkmeSourceItem = {
  sourceRef: 'reedit-source', sourceKey: 'chat:reedit', kind: 'private_chat', displayName: '附件编辑',
  activeAtMillis: 22, unreadCount: 0, latestSequence: 1,
}
const other = { ...source, sourceRef: 'other-source', sourceKey: 'chat:other', displayName: '其他会话' }
const item: ArkmeTimelineItem = {
  itemUid: 'record-a', messageActionRef: 'action-a', senderName: '我', isMe: true,
  sendAtMillis: 1, title: '', textContent: '原正文', status: 1, templateKind: 1, version: 3,
}
const existing = (id: string) => ({
  asset: { fileAssetUid: id, fileName: `${id}.pdf`, mimeType: 'application/pdf', size: 10, fileKind: 4 as const },
  selection: { fileAssetUid: id },
  block: { kind: 'file' as const, fileName: `${id}.pdf`, mediaRef: `media-${id}`, mimeType: 'application/pdf', size: 10, sortOrder: 0 },
})
const local = {
  fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000001',
  fileName: 'new.pdf', mimeType: 'application/pdf', size: 1, fileKind: 4 as const,
}
const baseline = () => ({
  sourceRef: source.sourceRef, itemUid: item.itemUid, title: '', textContent: item.textContent,
  sendAtMillis: 1, templateKind: 1, displayKind: 0, version: 3, maxTextLength: 4000,
  preservesAttachments: true, attachments: [existing('a'), existing('b')], hasVoice: false, maxAttachments: 9,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('record re-edit attachment UI', () => {
  let renderer: ReactTestRenderer | undefined
  let snapshot: ReturnType<typeof baseline> & { draft?: Record<string, unknown> }
  const normalKey = arkmeSourceComposerDraftKey(42, source)
  const composer = () => renderer!.root.findByType(ArkmeRichComposerInput)
  const strip = () => renderer!.root.findByType(ArkmeAttachmentStrip)
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  const open = async (index = 0) => {
    const bubble = renderer!.root.findAllByProps({ 'aria-label': '打开快记详情' })[index]!
    act(() => bubble.props.onContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 120, clientY: 180 }))
    const entry = renderer!.root.findByProps({ 'aria-label': '消息操作' }).findAllByProps({ role: 'menuitem' })
      .find(button => button.findAllByType('span').some(span => span.children.includes('重新编辑')))!
    await act(async () => { entry.props.onClick(); await flush() })
  }
  const mount = async () => {
    await act(async () => {
      renderer = create(<ArkmeSurface productChrome={false} productNavigation={false} />, {
        createNodeMock: element => element.props.className === 'arkme-conversation-panel'
          ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 720 }) } : null,
      })
      await flush()
    })
  }
  const pick = async () => {
    const input = renderer!.root.findAllByType('input').find(node => node.props.type === 'file')!
    await act(async () => { input.props.onChange({ currentTarget: { files: [new File(['x'], 'new.pdf', { type: 'application/pdf' })] } }); await flush() })
  }
  const stubStage = (stage: () => Promise<unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/files/stage')) return stage()
      const request = JSON.parse(String(init?.body)) as { operation: string; params?: Record<string, unknown> }
      return { json: async () => ({ ok: true, value: await mocks.callArkme(request.operation, request.params) }) }
    }))
  }

  it('shows submitted text and attachments in place while remote saving is still pending', async () => {
    arkmeComposerDraftStore.setText(normalKey, '普通发送草稿')
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.submit') return {
        submissionId: 'submit-1', state: 'pending', itemUid: item.itemUid,
        title: '', textContent: '待保存新正文', attachments: [existing('b')],
      }
      if (operation === 'source.record-reedit.submissions') return []
      return base(operation, params)
    })
    await mount()
    await open()
    act(() => composer().props.onTextChange('待保存新正文'))
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.submit', expect.objectContaining({ newText: '待保存新正文' }))
    expect(renderer!.root.findAllByProps({ 'aria-label': '保存重新编辑' })).toHaveLength(0)
    const row = renderer!.root.findByProps({ 'data-arkme-message-item-uid': item.itemUid })
    expect(JSON.stringify(renderer!.toJSON())).toContain('待保存新正文')
    expect(row.findByProps({ 'aria-label': '重新编辑保存状态' }).children).toContain('保存中')
    expect(composer().props.value).toBe('普通发送草稿')
    expect(arkmeComposerDraftStore.get(normalKey).text).toBe('普通发送草稿')
    expect(JSON.stringify(renderer!.toJSON())).toContain('b.pdf')
    expect(renderer!.root.findAllByProps({ 'data-arkme-highlight-backdrop': 'true' })).toHaveLength(0)
  })

  it('explicitly resumes on source activation and keeps receipt queries read-only', async () => {
    await mount()
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.resume', { sourceRef: source.sourceRef })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.submissions', { sourceRef: source.sourceRef })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.resume')).toHaveLength(1)
  })

  it('ignores an old receipt read after leaving and returning to the same source', async () => {
    const read = deferred<unknown>()
    const base = mocks.callArkme.getMockImplementation()!
    let count = 0
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.submissions') return ++count === 1 ? read.promise : []
      return base(operation, params)
    })
    await mount()
    await act(async () => { arkmeUi.selectSource(other); await flush() })
    await act(async () => { arkmeUi.selectSource(source); await flush() })
    await act(async () => { read.resolve([{ submissionId: 'stale', baseVersion: 3, itemUid: item.itemUid, state: 'pending', title: '', textContent: '迟到旧候选', attachments: [] }]); await flush() })
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('迟到旧候选')
  })

  it('previews the saved content matching the forward action instead of a pending edit', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.submissions') return [{
        submissionId: 'pending', baseVersion: 3, itemUid: item.itemUid, state: 'pending',
        title: '', textContent: '尚未保存候选', attachments: [],
      }]
      return base(operation, params)
    })
    await mount()
    const bubble = renderer!.root.findAllByProps({ 'aria-label': '打开快记详情' })[0]!
    act(() => bubble.props.onContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 120, clientY: 180 }))
    const forward = renderer!.root.findByProps({ 'aria-label': '消息操作' }).findAllByProps({ role: 'menuitem' })
      .find(button => button.findAllByType('span').some(span => span.children.includes('转发')))!
    await act(async () => { forward.props.onClick(); await flush() })
    const dialog = renderer!.root.findByProps({ 'aria-labelledby': 'arkme-forward-target-title' })
    const target = dialog.findAll(node => node.type === 'button' && typeof node.props['aria-pressed'] === 'boolean')[0]!
    act(() => { target.props.onClick() })
    const previewText = dialog.findAllByType('span').flatMap(span => span.children.filter(child => typeof child === 'string')).join('\n')
    expect(previewText).toContain('原正文')
    expect(previewText).not.toContain('尚未保存候选')
  })

  it.each([false, true])('restores a failed candidate without changing ordinary input even when activation fails: %s', async activationFails => {
    arkmeComposerDraftStore.setText(normalKey, '普通输入')
    snapshot.draft = { title: '', textContent: '失败候选', attachments: [existing('b')], baseVersion: 3, draftRevision: 1 }
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.resume' && activationFails) throw new Error('恢复执行暂不可用')
      if (operation === 'source.record-reedit.submissions') return [{ submissionId: 'failed', baseVersion: 3, itemUid: item.itemUid, state: 'failed', title: '', textContent: '失败候选', attachments: [existing('b')], error: '上传失败' }]
      return base(operation, params)
    })
    await mount()
    const restore = renderer!.root.findAllByType('button').find(button => button.children.includes('恢复编辑'))!
    await act(async () => { restore.props.onClick({ stopPropagation() {} }); await flush() })
    expect(composer().props.value).toBe('失败候选')
    expect(strip().props.attachments).toHaveLength(1)
    expect(arkmeComposerDraftStore.get(normalKey).text).toBe('普通输入')
  })

  beforeEach(() => {
    snapshot = baseline()
    const storage = new Map<string, string>()
    const storageApi = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } }
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, innerHeight: 900, localStorage: storageApi, sessionStorage: storageApi })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    arkmeComposerDraftStore.clearAccount(42)
    arkmeChatDirectory.clear()
    arkmeChatTimelineDelta.publish([])
    arkmeChatDirectory.activateAccount(42)
    arkmeChatDirectory.publish([source, other])
    arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 42 })
    arkmeMessageReadReceipts.activateAccount(42)
    arkmeUi.selectSource(source)
    mocks.callArkme.mockReset()
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.detail') return { ...snapshot, itemUid: params?.itemUid }
      if (operation === 'source.record-reedit.draft.put') return { saved: true, draftRevision: Number(params?.expectedDraftRevision ?? 0) + 1 }
      if (operation === 'source.record-reedit.submit') return { submissionId: 'submission', state: 'pending', itemUid: params?.itemUid, title: '', textContent: params?.newText, attachments: [] }
      if (operation === 'source.record-reedit.submissions') return []
      if (operation === 'source.record-reedit.resume') return { resumed: true }
      if (operation === 'files.capabilities') return { version: 1, maxFileBytes: 10_000, maxImageBytes: 10_000, maxAttachments: 9 }
      if (operation === 'source.timeline') return { source: arkmeUi.getSnapshot().selectedSource, items: [item, { ...item, itemUid: 'record-b', messageActionRef: 'action-b' }], hasMore: false }
      if (operation === 'sources.list') return { directory: 'root', items: [source, other], hasMore: false }
      if (operation === 'source.members') return { source, items: [], total: 0, activeCount: 0 }
      if (operation === 'source.interwoven-moments') return { state: 'disabled', moments: [], preparedAtMillis: 1 }
      if (operation === 'source.related-quick-notes.from-message') return { total: 0, items: [] }
      if (operation === 'records.tags.list') return { items: [] }
      throw new Error(`unexpected operation ${operation}`)
    })
    stubStage(async () => ({ json: async () => ({ ok: true, value: local }) }))
  })
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); await flush() })
    renderer = undefined
    arkmeComposerDraftStore.clearAccount(42)
    arkmeChatDirectory.clear()
    arkmeChatTimelineDelta.publish([])
    arkmeMessageReadReceipts.activateAccount(undefined)
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the existing strip to reorder and remove original attachments without touching the ordinary draft', async () => {
    arkmeComposerDraftStore.appendAttachments(normalKey, [{ localFile: local }], 9)
    await mount(); await open()
    expect(renderer!.root.findAllByType(ArkmeAttachmentStrip)).toHaveLength(1)
    expect(strip().props.attachments.map((attachment: ReturnType<typeof existing>) => attachment.asset.fileAssetUid)).toEqual(['a', 'b'])
    act(() => strip().props.onMove(1, 0))
    act(() => strip().props.onRemove(strip().props.attachments[1]))
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.draft.put', expect.objectContaining({ attachments: [{ fileAssetUid: 'b' }], expectedVersion: 3, expectedDraftRevision: 0 }))
    expect(arkmeComposerDraftStore.get(normalKey).attachments).toEqual([{ localFile: local }])
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'files.local.remove')).toHaveLength(0)
  })

  it('restores Tool attachment candidates and submits against their base version and draft revision', async () => {
    snapshot.draft = { title: '', textContent: '', attachments: [{ localFile: local, selection: { fileRef: local.fileRef } }], baseVersion: 2, draftRevision: 7, updatedAtMillis: 2 }
    await mount(); await open()
    expect(renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.disabled).toBe(false)
    expect(strip().props.attachments[0].localFile).toEqual(local)
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.submit', expect.objectContaining({ newText: '', attachments: [{ fileRef: local.fileRef }], expectedVersion: 2, expectedDraftRevision: 7 }))
  })

  it('adds picked files only to re-edit and blocks reentrant changes while local preparation is pending', async () => {
    const staged = deferred<unknown>()
    stubStage(async () => await staged.promise)
    arkmeComposerDraftStore.setText(normalKey, '普通草稿')
    await mount(); await open()
    expect(renderer!.root.findByProps({ 'aria-label': '添加内容' }).props.disabled).toBe(false)
    await pick()
    expect(renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.disabled).toBe(true)
    expect(renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.disabled).toBe(true)
    expect(renderer!.root.findByProps({ 'aria-label': '正在准备附件' })).toBeDefined()
    await pick()
    await act(async () => { staged.resolve({ json: async () => ({ ok: true, value: local }) }); await flush() })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/files/stage'))).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ role: 'alert' }).map(node => node.children)).toEqual([])
    expect(strip().props.attachments).toHaveLength(3)
    expect(arkmeComposerDraftStore.get(normalKey)).toMatchObject({ text: '普通草稿', attachments: [] })
  })

  it('routes pasted attachments through the same existing picker staging path', async () => {
    await mount(); await open()
    const preventDefault = vi.fn()
    await act(async () => {
      composer().props.onPaste({ preventDefault, clipboardData: { files: [new File(['x'], 'new.pdf', { type: 'application/pdf' })], items: [] } })
      await flush()
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByProps({ role: 'alert' }).map(node => node.children)).toEqual([])
    expect(strip().props.attachments).toHaveLength(3)
    expect(arkmeComposerDraftStore.get(normalKey).attachments).toHaveLength(0)
  })

  it('retains an attachment-only candidate when saving on close fails', async () => {
    await mount(); await open()
    act(() => { composer().props.onTextChange(''); strip().props.onRemove(strip().props.attachments[0]) })
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put') throw new Error('草稿保存失败')
      return base(operation, params)
    })
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.onClick(); await flush() })
    expect(renderer!.root.findAllByProps({ 'data-arkme-composer-reedit-target': 'true' })).toHaveLength(1)
    expect(composer().props.value).toBe('')
    expect(strip().props.attachments).toHaveLength(1)
    expect(renderer!.root.findByProps({ role: 'alert' }).children).toContain('草稿保存失败')
  })

  it.each(['source', 'account'] as const)('ignores late staged files after a %s context switch', async kind => {
    const staged = deferred<unknown>()
    stubStage(async () => await staged.promise)
    await mount(); await open(); await pick()
    await act(async () => {
      if (kind === 'source') arkmeUi.selectSource(other)
      else arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 43 })
      await flush()
      staged.resolve({ json: async () => ({ ok: true, value: local }) })
      await flush()
    })
    expect(renderer!.root.findAllByProps({ 'data-arkme-composer-reedit-target': 'true' })).toHaveLength(0)
    expect(arkmeComposerDraftStore.get(normalKey).attachments).toHaveLength(0)
    expect(arkmeComposerDraftStore.get(arkmeSourceComposerDraftKey(kind === 'account' ? 43 : 42, kind === 'account' ? source : other)).attachments).toHaveLength(0)
  })

  it('reactivates attachment staging after a failed save on leaving and returning to the source', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put') throw new Error('离线，草稿保存失败')
      return base(operation, params)
    })
    await mount(); await open()
    act(() => composer().props.onTextChange('留在来源 A 的候选'))
    await act(async () => { arkmeUi.selectSource(other); await flush() })
    await act(async () => { arkmeUi.selectSource(source); await flush() })
    expect(composer().props.value).toBe('留在来源 A 的候选')
    await pick()
    expect(strip().props.attachments).toHaveLength(3)
    expect(strip().props.attachments[2].localFile).toEqual(local)
    expect(arkmeComposerDraftStore.get(normalKey).attachments).toHaveLength(0)
  })

  it('does not let an exit-save failure in another source block normal message extension', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.draft.put') throw new Error('草稿保存失败')
      return base(operation, params)
    })
    await mount(); await open()
    act(() => composer().props.onTextChange('来源 A 未落盘草稿'))
    await act(async () => { arkmeUi.selectSource(other); await flush() })
    const bubble = renderer!.root.findAllByProps({ 'aria-label': '打开快记详情' })[0]!
    act(() => bubble.props.onContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 120, clientY: 180 }))
    const extend = renderer!.root.findByProps({ 'aria-label': '消息操作' }).findAllByProps({ role: 'menuitem' })
      .find(button => button.findAllByType('span').some(span => span.children.includes('延展')))!
    await act(async () => { extend.props.onClick(); await flush() })
    expect(renderer!.root.findAllByProps({ 'data-arkme-composer-extension-target': 'true' })).toHaveLength(1)
    await act(async () => { arkmeUi.selectSource(source); await flush() })
    expect(composer().props.value).toBe('来源 A 未落盘草稿')
  })

  it.each(['failed', 'committed'] as const)('uses three-second highlighting only for a confirmed edit: %s', async outcome => {
    vi.useFakeTimers()
    window.setTimeout = globalThis.setTimeout as typeof window.setTimeout
    window.clearTimeout = globalThis.clearTimeout as typeof window.clearTimeout
    let state: 'pending' | 'failed' | 'committed' = 'pending'
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation, params) => {
      if (operation === 'source.record-reedit.submissions') return [{ submissionId: 'highlight-test', itemUid: item.itemUid,
        state, baseVersion: 3, title: '', textContent: '提交候选', attachments: [],
        ...(state === 'committed' ? { result: { status: 'committed', itemUid: item.itemUid, version: 4, revisionUid: 'revision', projectionState: 'pending' } } : {}),
      }]
      return base(operation, params)
    })
    await mount()
    state = outcome
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(renderer!.root.findAllByProps({ 'data-arkme-highlight-backdrop': 'true' })).toHaveLength(outcome === 'committed' ? 1 : 0)
    if (outcome === 'failed') return
    await act(async () => { await vi.advanceTimersByTimeAsync(2999) })
    expect(renderer!.root.findAllByProps({ 'data-arkme-highlight-backdrop': 'true' })).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(renderer!.root.findAllByProps({ 'data-arkme-highlight-backdrop': 'true' })).toHaveLength(0)
  })

  it('reactivates conflict recovery after returning to a source whose exit save failed', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put') throw new ArkmeClientError({ code: 'record-reedit-conflict', message: '快记已更新，草稿保留', retryable: false })
      return base(operation, params)
    })
    await mount(); await open()
    act(() => composer().props.onTextChange('冲突候选'))
    await act(async () => { arkmeUi.selectSource(other); await flush() })
    await act(async () => { arkmeUi.selectSource(source); await flush() })
    const detailCalls = mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.detail').length
    act(() => renderer!.root.findByProps({ 'aria-label': '放弃草稿并重新载入' }).props.onClick())
    await act(async () => { renderer!.root.findByType(ArkmeConfirmDialog).props.onConfirm(); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.detail')).toHaveLength(detailCalls + 1)
    expect(composer().props.value).toBe('原正文')
    expect(renderer!.root.findAllByType(ArkmeConfirmDialog)).toHaveLength(0)
  })

  it('isolates an old pending stage from a resumed editor while accepting its new stage', async () => {
    const oldStage = deferred<unknown>()
    let stageCalls = 0
    stubStage(async () => ++stageCalls === 1 ? await oldStage.promise : { json: async () => ({ ok: true, value: local }) })
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put') throw new Error('离线，草稿保存失败')
      return base(operation, params)
    })
    await mount(); await open()
    act(() => composer().props.onTextChange('切换前候选'))
    await pick()
    await act(async () => { arkmeUi.selectSource(other); await flush() })
    await act(async () => { arkmeUi.selectSource(source); await flush() })
    await pick()
    expect(stageCalls).toBe(2)
    expect(strip().props.attachments).toHaveLength(3)
    await act(async () => {
      oldStage.resolve({ json: async () => ({ ok: true, value: { ...local, fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000002', fileName: '迟到旧文件.pdf' } }) })
      await flush()
    })
    expect(strip().props.attachments).toHaveLength(3)
    expect(strip().props.attachments[2].localFile).toEqual(local)
    expect(composer().props.value).toBe('切换前候选')
  })

  it('disables empty submissions unless a primary voice is retained', async () => {
    snapshot.textContent = ''; snapshot.attachments = []
    await mount(); await open()
    expect(renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.disabled).toBe(true)
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.onClick(); await flush() })
    snapshot.hasVoice = true
    await open()
    expect(renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.disabled).toBe(false)
  })
  it('keeps text editing and attachment removal available when adding attachments is unsupported', async () => {
    snapshot.displayKind = 1; snapshot.maxAttachments = 0
    const stage = vi.fn(async () => ({ json: async () => ({ ok: true, value: local }) }))
    stubStage(stage)
    await mount(); await open()
    expect(renderer!.root.findByProps({ 'aria-label': '添加内容' }).props.disabled).toBe(true)
    expect(composer().props.disabled).toBe(false)
    expect(strip().props.disabled).toBe(false)
    await pick()
    expect(stage).not.toHaveBeenCalled()
  })

  it('opens an authorized remote attachment in the existing media preview', async () => {
    await mount(); await open()
    vi.stubGlobal('document', { body: { style: { overflow: '' } }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const preview = renderer!.root.findByProps({ 'aria-label': '预览 a.pdf' })
    expect(preview.props.disabled).toBe(false)
    await act(async () => { preview.props.onClick(); await flush() })
    expect(renderer!.root.findByType(ArkmeMediaPreview).props.selected).toEqual(existing('a').block)
  })

  it('keeps the authorized image thumbnail inside the existing attachment tile', async () => {
    snapshot.attachments = [{
      ...existing('photo'),
      asset: { ...existing('photo').asset, fileName: 'photo.png', mimeType: 'image/png', fileKind: 1 },
      block: { ...existing('photo').block, kind: 'image', fileName: 'photo.png', mimeType: 'image/png' },
    }] as unknown as typeof snapshot.attachments
    await mount(); await open()
    expect(strip().findAllByType('img').map(node => node.props.src)).toContain('/arkme-self/api/media?ref=media-photo')
  })

  it('saves a completely empty candidate on exit while keeping final submission disabled', async () => {
    await mount(); await open()
    act(() => composer().props.onTextChange(''))
    act(() => strip().props.onRemove(strip().props.attachments[0]))
    act(() => strip().props.onRemove(strip().props.attachments[0]))
    expect(renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.disabled).toBe(true)
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.draft.put', expect.objectContaining({ newText: '', attachments: [], expectedDraftRevision: 0 }))
  })

  it('persists the candidate revision before commit and retains it for a failed-commit retry', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    let failCommit = true
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.submit' && failCommit) throw new Error('上传失败，请重试')
      return base(operation, params)
    })
    await mount(); await open()
    act(() => strip().props.onRemove(strip().props.attachments[0]))
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => ['source.record-reedit.draft.put', 'source.record-reedit.submit'].includes(operation)).map(([operation, params]) => [operation, params.expectedDraftRevision])).toEqual([
      ['source.record-reedit.draft.put', 0], ['source.record-reedit.submit', 1],
    ])
    expect(strip().props.attachments).toHaveLength(1)
    expect(renderer!.root.findByProps({ role: 'alert' }).children).toContain('上传失败，请重试')
    failCommit = false
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.submit').map(([, params]) => params.expectedDraftRevision)).toEqual([1, 1])
    expect(renderer!.root.findAllByProps({ 'data-arkme-composer-reedit-target': 'true' })).toHaveLength(0)
  })

  it('obtains a known draft revision even when submitting an unchanged original record', async () => {
    await mount(); await open()
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => ['source.record-reedit.draft.put', 'source.record-reedit.submit'].includes(operation)).map(([operation, params]) => [operation, params.expectedDraftRevision])).toEqual([
      ['source.record-reedit.draft.put', 0], ['source.record-reedit.submit', 1],
    ])
  })

  it('serializes autosaves and carries the returned revision into the next candidate', async () => {
    vi.useFakeTimers()
    const firstSave = deferred<{ saved: true; draftRevision: number }>()
    const base = mocks.callArkme.getMockImplementation()!
    let saves = 0
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put' && saves++ === 0) return await firstSave.promise
      return base(operation, params)
    })
    await mount(); await open()
    act(() => strip().props.onMove(0, 1))
    await act(async () => { vi.advanceTimersByTime(10_000); await flush() })
    act(() => composer().props.onTextChange('第二份候选'))
    await act(async () => { vi.advanceTimersByTime(10_000); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.put')).toHaveLength(1)
    await act(async () => { firstSave.resolve({ saved: true, draftRevision: 5 }); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.put').map(([, params]) => params.expectedDraftRevision)).toEqual([0, 5])
  })

  it('does not lose a candidate reverted to the original while an older save is queued', async () => {
    vi.useFakeTimers()
    const firstSave = deferred<{ saved: true; draftRevision: number }>()
    const base = mocks.callArkme.getMockImplementation()!
    let saves = 0
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.put' && saves++ === 0) return await firstSave.promise
      return base(operation, params)
    })
    await mount(); await open()
    act(() => composer().props.onTextChange('排队中的旧候选'))
    await act(async () => { vi.advanceTimersByTime(10_000); await flush() })
    act(() => composer().props.onTextChange('原正文'))
    act(() => { renderer!.root.findByProps({ 'aria-label': '关闭重新编辑' }).props.onClick() })
    await act(async () => { firstSave.resolve({ saved: true, draftRevision: 1 }); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.put').map(([, params]) => [params.newText, params.expectedDraftRevision])).toEqual([
      ['排队中的旧候选', 0], ['原正文', 1],
    ])
  })

  it('confirms before discarding a version-conflicted draft and reloads owner attachments', async () => {
    snapshot.draft = { title: '', textContent: '冲突草稿', attachments: [existing('b')], baseVersion: 2, draftRevision: 7, updatedAtMillis: 2 }
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.draft.delete') { snapshot = baseline(); return { status: 'discarded', itemUid: item.itemUid } }
      return base(operation, params)
    })
    await mount(); await open()
    const reload = () => renderer!.root.findByProps({ 'aria-label': '放弃草稿并重新载入' })
    act(() => reload().props.onClick())
    expect(renderer!.root.findByType(ArkmeConfirmDialog).props.confirmLabel).toBe('放弃并重新载入')
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.delete')).toHaveLength(0)
    act(() => renderer!.root.findByType(ArkmeConfirmDialog).props.onClose())
    expect(composer().props.value).toBe('冲突草稿')
    act(() => reload().props.onClick())
    await act(async () => { renderer!.root.findByType(ArkmeConfirmDialog).props.onConfirm(); await flush() })
    expect(mocks.callArkme).toHaveBeenCalledWith('source.record-reedit.draft.delete', { sourceRef: source.sourceRef, itemUid: item.itemUid, expectedDraftRevision: 7 })
    expect(composer().props.value).toBe('原正文')
    expect(strip().props.attachments.map((attachment: ReturnType<typeof existing>) => attachment.asset.fileAssetUid)).toEqual(['a', 'b'])
  })

  it('reloads another consumer changed draft without deleting the newly observed candidate', async () => {
    snapshot.draft = { title: '', textContent: '原候选', attachments: [existing('b')], baseVersion: 2, draftRevision: 7, updatedAtMillis: 2 }
    await mount(); await open()
    act(() => renderer!.root.findByProps({ 'aria-label': '放弃草稿并重新载入' }).props.onClick())
    snapshot.draft = { ...snapshot.draft, textContent: '其他入口新候选', draftRevision: 8 }
    await act(async () => { renderer!.root.findByType(ArkmeConfirmDialog).props.onConfirm(); await flush() })
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.delete')).toHaveLength(0)
    expect(composer().props.value).toBe('其他入口新候选')
    expect(renderer!.root.findAllByType(ArkmeConfirmDialog)).toHaveLength(0)
  })

  it('offers a non-destructive reload when the draft revision has changed', async () => {
    const base = mocks.callArkme.getMockImplementation()!
    mocks.callArkme.mockImplementation(async (operation: string, params?: Record<string, unknown>) => {
      if (operation === 'source.record-reedit.submit') throw new ArkmeClientError({ code: 'record-reedit-draft-changed', message: '其他入口已更新草稿', retryable: false })
      return base(operation, params)
    })
    await mount(); await open()
    await act(async () => { renderer!.root.findByProps({ 'aria-label': '保存重新编辑' }).props.onClick(); await flush() })
    expect(renderer!.root.findAllByProps({ 'aria-label': '放弃草稿并重新载入' })).toHaveLength(0)
    act(() => renderer!.root.findByProps({ 'aria-label': '重新载入草稿' }).props.onClick())
    snapshot.draft = { title: '', textContent: '最新草稿', attachments: [], baseVersion: 3, draftRevision: 8, updatedAtMillis: 2 }
    await act(async () => { renderer!.root.findByType(ArkmeConfirmDialog).props.onConfirm(); await flush() })
    expect(composer().props.value).toBe('最新草稿')
    expect(mocks.callArkme.mock.calls.filter(([operation]) => operation === 'source.record-reedit.draft.delete')).toHaveLength(0)
  })
})
