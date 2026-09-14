// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatPreviewTimeline } from '../src/client/use-chat-preview-timeline.js'
import type { ConversationTimelineReadPort } from '../src/client/conversation-timeline-read-port.js'
import type { ArkmeTimelineItem, ArkmeTimelinePage } from '../src/types.js'

const message = (sequence: number): ArkmeTimelineItem => ({ itemUid: String(sequence), sequence, status: 1, senderName: '作者', isMe: false, sendAtMillis: sequence, textContent: `消息${sequence}`, title: '' })
const page = (sequences: number[], before?: number): ArkmeTimelinePage => ({ source: { sourceRef: 'signed', kind: 'group_chat', displayName: '群聊', unreadCount: 10, activeAtMillis: 1 }, items: sequences.map(message), hasMore: before !== undefined, ...(before === undefined ? {} : { nextCursor: { beforeSequence: before } }) })
let root: Root, host: HTMLDivElement
let timeline: ReturnType<typeof useChatPreviewTimeline>
let readPage: ReturnType<typeof vi.fn<ConversationTimelineReadPort['readPage']>>
let port: ConversationTimelineReadPort
function Harness({ sourceRef = 'signed', revision = 0 }: { sourceRef?: string; revision?: number }) {
  timeline = useChatPreviewTimeline(sourceRef, revision, port)
  return <div>{timeline.page?.items.map(item => item.textContent).join(',')}{timeline.error}</div>
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  readPage = vi.fn(); port = { readPage }
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const render = async (sourceRef = 'signed', revision = 0) => { await act(async () => root.render(<Harness key={sourceRef} sourceRef={sourceRef} revision={revision} />)) }

it('exposes loading, empty and success without any write capability', async () => {
  const pending = Promise.withResolvers<ArkmeTimelinePage>()
  readPage.mockReturnValueOnce(pending.promise)
  await render()
  expect(timeline.loading).toBe(true)
  await act(async () => pending.resolve(page([])))
  expect(timeline.loading).toBe(false)
  expect(timeline.page?.items).toEqual([])
  readPage.mockResolvedValueOnce(page([3, 2]))
  await act(async () => timeline.refresh())
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 3])
})

it('deduplicates pagination, keeps loaded messages on failure and retries the failed cursor', async () => {
  readPage.mockResolvedValueOnce(page([5, 4], 4))
  await render()
  const pending = Promise.withResolvers<ArkmeTimelinePage>()
  readPage.mockReturnValueOnce(pending.promise)
  await act(async () => { void timeline.loadMore(); void timeline.loadMore() })
  expect(readPage).toHaveBeenCalledTimes(2)
  await act(async () => pending.reject(new Error('网络中断')))
  expect(timeline.error).toBe('网络中断')
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([4, 5])
  readPage.mockResolvedValueOnce(page([4, 3]))
  await act(async () => timeline.retry())
  expect(readPage.mock.calls[2]?.[1]).toEqual({ beforeSequence: 4 })
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([3, 4, 5])
})

it.each([undefined, { beforeSequence: 4 }])('rejects a missing or nonadvancing next cursor %j', async nextCursor => {
  readPage.mockResolvedValueOnce(page([5], 4))
  await render()
  readPage.mockResolvedValueOnce({ ...page([3]), hasMore: true, ...(nextCursor === undefined ? {} : { nextCursor }) })
  await act(async () => timeline.loadMore())
  expect(timeline.error).toContain('分页')
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([5])
})

it('aborts old scope work and ignores late results even if the transport ignores abort', async () => {
  const old = Promise.withResolvers<ArkmeTimelinePage>()
  readPage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([9]))
  await render('old-account')
  const signal = readPage.mock.calls[0]![2]
  await render('new-account')
  expect(signal.aborted).toBe(true)
  await act(async () => old.resolve(page([1])))
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([9])
  expect(host.textContent).not.toContain('消息1')
})

it('marks changes for explicit refresh, preserves the loaded window and does not fetch for unrelated renders', async () => {
  readPage.mockResolvedValueOnce(page([5, 4], 4)).mockResolvedValueOnce(page([3, 2], 2))
  await render()
  await act(async () => timeline.loadMore())
  await render('signed', 1)
  expect(timeline.hasChanges).toBe(true)
  expect(readPage).toHaveBeenCalledTimes(2)
  readPage.mockResolvedValueOnce(page([6, 5], 5)).mockResolvedValueOnce(page([4, 2], 2))
  await act(async () => timeline.refresh())
  expect(timeline.hasChanges).toBe(false)
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 4, 5, 6])
  expect(timeline.page?.nextCursor).toEqual({ beforeSequence: 2 })
})

it('times out with retry and discards a late response', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<ArkmeTimelinePage>()
  readPage.mockReturnValueOnce(pending.promise)
  await render()
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(timeline.loading).toBe(false)
  expect(timeline.error).toContain('超时')
  readPage.mockResolvedValueOnce(page([8]))
  await act(async () => timeline.retry())
  await act(async () => pending.resolve(page([1])))
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([8])
})

it('preserves history on a same-conversation access-ref rotation and rereads using the new ref', async () => {
  readPage.mockResolvedValueOnce(page([5, 4], 4)).mockResolvedValueOnce(page([3, 2], 2))
  await render()
  await act(async () => timeline.loadMore())
  readPage.mockResolvedValueOnce(page([5, 4], 4)).mockResolvedValueOnce(page([3, 2], 2))
  await act(async () => root.render(<Harness key="signed" sourceRef="new-signed-ref" />))
  expect(readPage.mock.calls.slice(2).map(call => call[0])).toEqual(['new-signed-ref', 'new-signed-ref'])
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 3, 4, 5])
})

it('retains pagination when refreshing a previously empty conversation', async () => {
  readPage.mockResolvedValueOnce(page([]))
  await render()
  readPage.mockResolvedValueOnce(page([5, 4], 4))
  await act(async () => timeline.refresh())
  expect(timeline.page?.hasMore).toBe(true)
  expect(timeline.page?.nextCursor).toEqual({ beforeSequence: 4 })
  readPage.mockResolvedValueOnce(page([3, 2]))
  await act(async () => timeline.loadMore())
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 3, 4, 5])
})

it('retains the change notification when another update arrives during refresh', async () => {
  readPage.mockResolvedValueOnce(page([1]))
  await render()
  await render('signed', 1)
  const pending = Promise.withResolvers<ArkmeTimelinePage>()
  readPage.mockReturnValueOnce(pending.promise)
  await act(async () => { void timeline.refresh() })
  await render('signed', 2)
  await act(async () => pending.resolve(page([2, 1])))
  expect(timeline.hasChanges).toBe(true)
  readPage.mockResolvedValueOnce(page([3, 2, 1]))
  await act(async () => timeline.refresh())
  expect(timeline.hasChanges).toBe(false)
})

it('keeps the entire loaded window after a partial refresh fails and retries from the latest page', async () => {
  readPage.mockResolvedValueOnce(page([5, 4], 4)).mockResolvedValueOnce(page([3, 2], 2))
  await render()
  await act(async () => timeline.loadMore())
  readPage.mockResolvedValueOnce(page([6, 5], 5)).mockRejectedValueOnce(new Error('第二页失败'))
  await act(async () => timeline.refresh())
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 3, 4, 5])
  expect(timeline.error).toBe('第二页失败')
  readPage.mockResolvedValueOnce(page([6, 5], 5)).mockResolvedValueOnce(page([4, 2], 2))
  await act(async () => timeline.retry())
  expect(readPage.mock.calls.at(-2)?.[1]).toBeUndefined()
  expect(timeline.page?.items.map(item => item.sequence)).toEqual([2, 4, 5, 6])
})
