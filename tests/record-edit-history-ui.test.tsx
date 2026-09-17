// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ArkmeRecordEditHistoryPage, ArkmeRecordEditHistoryReader } from '../src/record-edit-history.js'
vi.mock('../src/client/ArkmeRichContent.js', () => ({ ArkmeMessageContent: ({ item }: { item: { textContent: string } }) => <p>{item.textContent}</p> }))
import { ArkmeRecordEditHistory } from '../src/client/ArkmeRecordEditHistory.js'
const page = (id: string): ArkmeRecordEditHistoryPage => ({ items: [{ revisionUid: id, kind: 'manual', editAtMillis: 1700000000000, content: { title: '', textContent: id, contentBlocks: [] } }], hasMore: false })
async function render(reader: ArkmeRecordEditHistoryReader) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<ArkmeRecordEditHistory sourceRef="s" messageActionRef="a" reader={reader} />) })
  return view
}
const button = (view: ReactTestRenderer, text: string) => view.root.findAllByType('button').find(node => node.children.includes(text))!

describe('edit history view', () => {
  it('renders latest snapshot and unmount aborts its scope', async () => {
    const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>(async () => page('old snapshot')) }
    const view = await render(reader)
    expect(JSON.stringify(view.toJSON())).toContain('old snapshot')
    expect(JSON.stringify(view.toJSON())).toContain('最新')
    const signal = reader.page.mock.calls[0]?.[3] as AbortSignal | undefined
    act(() => view.unmount())
    expect(signal?.aborted).toBe(true)
  })
  it('keeps pagination reachable when a whole page is filtered and blocks duplicate loads', async () => {
    let resolve!: (value: ArkmeRecordEditHistoryPage) => void
    const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>()
      .mockResolvedValueOnce({ items: [], hasMore: true, nextCursorEditAt: 100 })
      .mockImplementationOnce(() => new Promise(done => { resolve = done })) }
    const view = await render(reader)
    expect(button(view, '加载更多')).toBeDefined()
    await act(async () => { button(view, '加载更多').props.onClick(); button(view, '加载更多').props.onClick() })
    expect(reader.page).toHaveBeenCalledTimes(2)
    await act(async () => resolve(page('original')))
    expect(JSON.stringify(view.toJSON())).toContain('original')
    act(() => view.unmount())
  })
  it('retains loaded revisions on pagination failure and retries the same cursor', async () => {
    const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>()
      .mockResolvedValueOnce({ ...page('first'), hasMore: true, nextCursorEditAt: 100 })
      .mockRejectedValueOnce(new Error('网络失败')).mockResolvedValueOnce(page('second')) }
    const view = await render(reader)
    await act(async () => button(view, '加载更多').props.onClick())
    expect(JSON.stringify(view.toJSON())).toContain('first')
    await act(async () => button(view, '重试').props.onClick())
    expect(reader.page.mock.calls[2]?.[2]).toBe(100)
    expect(JSON.stringify(view.toJSON())).toContain('second')
    act(() => view.unmount())
  })
  it('does not apply a late response after changing the target', async () => {
    let resolve!: (value: ArkmeRecordEditHistoryPage) => void
    const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>()
      .mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(page('new')) }
    const view = await render(reader)
    await act(async () => view.update(<ArkmeRecordEditHistory sourceRef="s2" messageActionRef="b" reader={reader} />))
    await act(async () => resolve(page('stale')))
    expect(JSON.stringify(view.toJSON())).toContain('new')
    expect(JSON.stringify(view.toJSON())).not.toContain('stale')
    act(() => view.unmount())
  })
  it('bounds eventual-consistency retries and cancels pending retry timers on close', async () => {
    vi.useFakeTimers()
    try {
      const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>().mockResolvedValue({ items: [], hasMore: false }) }
      const view = await render(reader)
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(reader.page).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(view.toJSON())).toContain('暂无编辑记录')
      act(() => view.unmount())
      const pending = await render(reader)
      act(() => pending.unmount())
      const count = reader.page.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(reader.page).toHaveBeenCalledTimes(count)
    } finally { vi.useRealTimers() }
  })

  it('retries a failed media refresh from the first page instead of the pagination cursor', async () => {
    const first = page('first')
    first.items[0]!.content.mediaUnavailable = true
    const reader = { page: vi.fn<ArkmeRecordEditHistoryReader['page']>()
      .mockResolvedValueOnce({ ...first, hasMore: true, nextCursorEditAt: 100 })
      .mockRejectedValueOnce(new Error('刷新失败')).mockResolvedValueOnce(page('refreshed')) }
    const view = await render(reader)
    await act(async () => button(view, '重新加载历史附件').props.onClick())
    await act(async () => button(view, '重试').props.onClick())
    expect(reader.page.mock.calls[2]?.[2]).toBe(0)
    expect(JSON.stringify(view.toJSON())).not.toContain('first')
    act(() => view.unmount())
  })

  it('shows query errors instead of empty success', async () => {
    const view = await render({ page: vi.fn().mockRejectedValue(new Error('没有权限')) })
    expect(JSON.stringify(view.toJSON())).toContain('没有权限')
    expect(button(view, '重试')).toBeDefined()
    act(() => view.unmount())
  })
})
