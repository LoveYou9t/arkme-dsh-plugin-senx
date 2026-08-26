import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { ArkmeMessageContent } from '../src/client/ArkmeRichContent.js'
import type { ArkmeTimelineItem } from '../src/types.js'

const complete: ArkmeTimelineItem = {
  itemUid: 'file-record', senderName: 'sender', isMe: false, sendAtMillis: 1,
  title: 'report.pdf', textContent: '', status: 1, version: 7,
  contentBlocks: [{ kind: 'file', mediaRef: 'remote-file', fileAssetUid: 'asset', fileName: 'report.pdf', mimeType: 'application/pdf', size: 100, sortOrder: 0 }],
}
const unavailable: ArkmeTimelineItem = { ...complete, contentBlocks: [], mediaUnavailable: true }
const cardCount = (view: ReactTestRenderer) => view.root.findAll(node => node.type === 'button' && node.props['data-arkme-file-card'] === 'file').length

describe('file message refresh stability', () => {
  it('keeps a mounted file card through a same-version media lookup failure and recovery', async () => {
    let view!: ReactTestRenderer
    const counts: number[] = []
    for (const item of [complete, unavailable, complete]) {
      await act(async () => { if (view === undefined) view = create(<ArkmeMessageContent sourceRef="source-a" item={item} />); else view.update(<ArkmeMessageContent sourceRef="source-a" item={item} />) })
      counts.push(cardCount(view))
    }
    await act(async () => view.unmount())
    expect(counts).toEqual([1, 1, 1])
  })
  it.each([
    ['authoritative attachment removal', { ...complete, contentBlocks: [] }, 'source-a'],
    ['newer record revision', { ...unavailable, version: 8 }, 'source-a'],
    ['unknown revision', { ...unavailable, version: undefined }, 'source-a'],
    ['deleted record', { ...unavailable, status: 2 }, 'source-a'],
    ['another record', { ...unavailable, itemUid: 'other-record' }, 'source-a'],
    ['another source', unavailable, 'source-b'],
  ])('does not retain old media for %s', async (_name, next, sourceRef) => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeMessageContent sourceRef="source-a" item={complete} />) })
    await act(async () => { view.update(<ArkmeMessageContent sourceRef={sourceRef} item={next} />) })
    expect(cardCount(view)).toBe(0)
    await act(async () => view.unmount())
  })
  it('replaces retained references on recovery and does not resurrect removed media later', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(<ArkmeMessageContent item={complete} />) })
    await act(async () => { view.update(<ArkmeMessageContent item={unavailable} />) })
    expect(cardCount(view)).toBe(1)
    expect(JSON.stringify(view.toJSON())).toContain('部分媒体暂时无法加载')
    await act(async () => { view.update(<ArkmeMessageContent item={{ ...complete, contentBlocks: [{ ...complete.contentBlocks![0]!, fileName: 'recovered.pdf', mediaRef: 'renewed-ref' }] }} />) })
    expect(JSON.stringify(view.toJSON())).toContain('recovered.pdf')
    await act(async () => { view.update(<ArkmeMessageContent item={{ ...complete, contentBlocks: [] }} />) })
    await act(async () => { view.update(<ArkmeMessageContent item={unavailable} />) })
    expect(cardCount(view)).toBe(0)
    await act(async () => view.unmount())
  })
})
