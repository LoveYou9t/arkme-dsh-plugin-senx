import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkmeFileActions, ArkmeFileViewer, useArkmeOriginal } from '../src/client/ArkmeFileViewer.js'
import type { ReactNode } from 'react'
import { ArkmeSdk } from '../src/sdk/index.js'
import { ArkmeFileQuickView } from '../src/client/ArkmeFileQuickView.js'

const api = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../src/client/api.js', () => ({ callArkme: api.call }))
vi.mock('react-dom', async importOriginal => ({ ...await importOriginal<typeof import('react-dom')>(), createPortal: (children: ReactNode) => children }))
const block = { kind: 'file' as const, mediaRef: '', fileName: 'a.pdf', mimeType: 'application/pdf', size: 3, sortOrder: 0 }
const original = { localRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000001', reception: { state: 'ready' as const, receivedBytes: 3, totalBytes: 3 }, receive: vi.fn() }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('file save UI', () => {
  it('uses the client download icon before reception, and cancelling never starts a download', async () => {
    const receive = vi.spyOn(ArkmeSdk.prototype, 'receiveFile')
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw new DOMException('cancelled', 'AbortError') } })
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileActions block={{ ...block, originalRef: 'arkme-media-v1.original' }} original={{ reception: { state: 'missing', receivedBytes: 0, totalBytes: 3 }, localRef: undefined, receive: vi.fn() }} />) })
    expect(view.root.findByType('button').props['aria-label']).toBe('下载文件')
    expect(view.root.findAllByType('svg')).toHaveLength(1)
    expect(JSON.stringify(view.toJSON())).not.toContain('另存为')
    await act(async () => { view.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(receive).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.stringify(view.toJSON())).not.toContain('保存成功')
    await act(async () => view.unmount())
  })
  it('selects a save destination before receiving the original and writing it', async () => {
    const order: string[] = []
    vi.spyOn(ArkmeSdk.prototype, 'receiveFile').mockImplementation(async () => {
      order.push('receive')
      return { state: 'ready', receivedBytes: 3, totalBytes: 3, file: { fileRef: original.localRef, fileName: 'a.pdf', mimeType: 'application/pdf', size: 3, fileKind: 4 } }
    })
    const writable = { write: vi.fn(async () => { order.push('write') }), close: vi.fn(async () => { order.push('close') }), abort: vi.fn() }
    vi.stubGlobal('window', { showSaveFilePicker: async () => { order.push('picker'); return { createWritable: async () => writable } } })
    vi.stubGlobal('fetch', async () => { order.push('read original'); return new Response('abc') })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileActions block={{ ...block, originalRef: 'arkme-media-v1.original' }} original={{ reception: { state: 'missing', receivedBytes: 0, totalBytes: 3 }, localRef: undefined, receive: vi.fn() }} />) })
    await act(async () => { view.root.findByType('button').props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(order).toEqual(['picker', 'receive', 'read original', 'write', 'close'])
    expect(JSON.stringify(view.toJSON())).toContain('保存成功')
    expect(view.root.findAllByType('button')).toHaveLength(0)
    await act(async () => view.unmount())
  })
  it('cancelling Save As does not fetch bytes or claim success', async () => {
    const picker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
    const fetcher = vi.fn()
    vi.stubGlobal('window', { showSaveFilePicker: picker }); vi.stubGlobal('fetch', fetcher)
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileActions block={block} original={original} />) })
    await act(async () => { view.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'a.pdf' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.stringify(view.toJSON())).not.toContain('保存成功')
    await act(async () => view.unmount())
  })
  it('reports only browser handoff when the native picker is unavailable', async () => {
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('window', {}); vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileActions block={block} original={original} />) })
    await act(async () => { view.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.href).toContain('/files/local?ref=')
    expect(anchor.href).toContain('download=1')
    expect(JSON.stringify(view.toJSON())).toContain('已交给浏览器下载')
    expect(JSON.stringify(view.toJSON())).not.toContain('保存成功')
    await act(async () => view.unmount())
  })
  it('aborts an incomplete disk write and never reports success', async () => {
    const writable = { write: vi.fn(async () => { throw new Error('disk full') }), close: vi.fn(), abort: vi.fn(async () => {}) }
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ createWritable: async () => writable }) })
    vi.stubGlobal('fetch', async () => new Response('abc'))
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileActions block={block} original={original} />) })
    await act(async () => { view.root.findByType('button').props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(writable.abort).toHaveBeenCalledOnce(); expect(writable.close).not.toHaveBeenCalled()
    expect(JSON.stringify(view.toJSON())).toContain('disk full')
    expect(JSON.stringify(view.toJSON())).not.toContain('保存成功')
    await act(async () => view.unmount())
  })
})

describe('shared original-file reception display', () => {
  it('updates the message card when reception is started in its viewer', async () => {
    vi.useFakeTimers()
    const receive = vi.spyOn(ArkmeSdk.prototype, 'receiveFile').mockResolvedValue({ state: 'missing', receivedBytes: 0, totalBytes: 3 })
    function Probe({ name }: { name: string }) {
      const value = useArkmeOriginal({ ...block, originalRef: 'arkme-media-v1.shared' })
      return <button aria-label={name} onClick={value.receive}>{value.reception.state}</button>
    }
    let view!: ReactTestRenderer
    await act(async () => { view = create(<><Probe name="card" /><Probe name="viewer" /></>) })
    receive.mockResolvedValue({ state: 'receiving', receivedBytes: 1, totalBytes: 3 })
    await act(async () => view.root.findByProps({ 'aria-label': 'viewer' }).props.onClick())
    expect(view.root.findByProps({ 'aria-label': 'card' }).props.children).toBe('receiving')
    receive.mockResolvedValue({ state: 'ready', receivedBytes: 3, totalBytes: 3 })
    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    expect(view.root.findByProps({ 'aria-label': 'card' }).props.children).toBe('ready')
    await act(async () => view.unmount())
  })
})

describe('client file preview interaction', () => {
  it('keeps the close control inside the file panel and preserves click and Escape dismissal', async () => {
    vi.stubGlobal('document', { body: {}, activeElement: null })
    const onClose = vi.fn()
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileViewer block={block} onClose={onClose} />) })
    const dialog = view.root.findByProps({ role: 'dialog' })
    const close = view.root.findByProps({ 'aria-label': '关闭文件预览' })
    expect(close.props.style).toMatchObject({ position: 'absolute', right: 12, top: 12, width: 32, height: 32 })
    expect(close.props.style.color).not.toBe('white')
    expect(dialog.props.style.padding).toBe('48px 40px 32px')
    await act(async () => close.props.onClick())
    expect(onClose).toHaveBeenCalledOnce()
    const stopPropagation = vi.fn()
    await act(async () => dialog.props.onKeyDown({ key: 'Escape', stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledTimes(2)
    await act(async () => view.unmount())
  })
  it('shows Receive in the file panel, with a separate download icon and no invented Save As button', async () => {
    vi.stubGlobal('document', { body: {}, activeElement: null })
    const receive = vi.spyOn(ArkmeSdk.prototype, 'receiveFile').mockResolvedValue({ state: 'missing', receivedBytes: 0, totalBytes: 3 })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileViewer block={{ ...block, originalRef: 'arkme-media-v1.panel' }} onClose={() => {}} />) })
    expect(view.root.findAllByType('button').some(button => button.props.children === '接收文件')).toBe(true)
    expect(view.root.findByProps({ 'aria-label': '下载文件' })).toBeDefined()
    const fileIcon = view.root.findByType('img')
    expect(fileIcon.props['data-arkme-file-icon-set']).toBe('untitled-solid')
    expect(fileIcon.props.width).toBe(64)
    expect(fileIcon.props.height).toBe(64)
    expect(fileIcon.props.style).toMatchObject({ width: 64, height: 64, objectFit: 'contain' })
    expect(JSON.stringify(view.toJSON())).not.toContain('另存为')
    expect(receive).toHaveBeenCalledWith('arkme-media-v1.panel', false, expect.any(AbortSignal))
    await act(async () => view.unmount())
  })
  it('opens a staged Markdown file using the public formatted renderer without uploading it', async () => {
    vi.stubGlobal('document', { body: {}, activeElement: null })
    const receive = vi.spyOn(ArkmeSdk.prototype, 'receiveFile')
    vi.stubGlobal('fetch', async () => new Response('# 标题\n\n**重点**\n\n<script>unsafe()</script>'))
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileViewer block={{ ...block, fileName: 'a.md', mimeType: 'text/markdown', localFileRef: original.localRef }} onClose={() => {}} />) })
    await act(async () => { view.root.findAllByType('button').find(button => button.props.children === '打开')!.props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(view.root.findByType('h1').props.children).toBe('标题')
    expect(view.root.findByType('strong').props.children).toEqual(['重点'])
    expect(view.root.findByProps({ role: 'dialog' }).props.style.padding).toBe('56px 20px 20px')
    expect(view.root.findByProps({ 'aria-label': '关闭文件预览' }).props.style).toMatchObject({ top: 12, right: 12 })
    expect(view.root.findAllByType('script')).toHaveLength(0)
    expect(receive).not.toHaveBeenCalled()
    await act(async () => view.unmount())
  })
})

describe('file quick search UI', () => {
  it('uses the existing file lane, paginates, and exposes source navigation', async () => {
    vi.useFakeTimers()
    const item = { recordUid: 'record', sourceKind: 1, routeTargetKind: 'topic', sendAtMillis: 1, title: '', textContent: '', snippet: '', media: [], files: [{ fileAssetUid: 'asset', fileName: 'report.pdf', size: 20 }], targetSource: { sourceRef: 'source', kind: 'topic' } }
    api.call.mockResolvedValueOnce({ items: [item], hasMore: true, nextCursor: 'next', sourceAggregates: [] }).mockResolvedValueOnce({ items: [], hasMore: false, sourceAggregates: [] })
    const onOpen = vi.fn(); let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeFileQuickView query="" onOpenRecord={onOpen} />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api.call).toHaveBeenCalledWith('files.search', { query: '', limit: 30 }, expect.any(AbortSignal))
    await act(async () => view.root.findAllByType('button').find(button => button.props.children === '查看来源')!.props.onClick())
    expect(onOpen).toHaveBeenCalledWith(item)
    await act(async () => view.root.findAllByType('button').find(button => button.props.children === '加载更多')!.props.onClick())
    expect(api.call).toHaveBeenLastCalledWith('files.search', { query: '', limit: 30, cursor: 'next' }, expect.any(AbortSignal))
    expect(JSON.stringify(view.toJSON())).toContain('report.pdf')
    await act(async () => view.unmount())
  })
})
