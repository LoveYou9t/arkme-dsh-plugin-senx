import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArkmeRecordReeditSubmissionView } from '../src/record-reedit-contract.js'
import type { ArkmeTimelineItem } from '../src/types.js'
import { ArkmeMessageContent } from '../src/client/ArkmeRichContent.js'
import { projectRecordReedit } from '../src/client/record-reedit-submissions.js'

describe('re-edit candidate media completeness', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => { act(() => { renderer?.unmount() }) })

  it.each(['pending', 'committed'] as const)('shows an explicit attachment removal while %s instead of restoring stale media', state => {
    const original: ArkmeTimelineItem = {
      itemUid: 'record', senderName: '我', isMe: true, title: '', textContent: '原文',
      recordVersion: 7, version: 5, status: 1, sendAtMillis: 1,
      contentBlocks: [{ kind: 'image', mediaRef: 'authorized-media', fileAssetUid: 'asset-original',
        fileName: 'removed.png', mimeType: 'image/png', size: 10, sortOrder: 0 }],
    }
    act(() => { renderer = create(<ArkmeMessageContent item={original} sourceRef="source" />) })
    const sparse = { ...original, contentBlocks: [], mediaUnavailable: true }
    act(() => { renderer!.update(<ArkmeMessageContent item={sparse} sourceRef="source" />) })
    expect(renderer!.root.findAllByType('img')).toHaveLength(1)

    const job: ArkmeRecordReeditSubmissionView = {
      submissionId: 'submission', itemUid: original.itemUid, state, baseVersion: 7,
      title: '', textContent: '保留正文并移除图片', attachments: [],
      ...(state === 'committed' ? { result: { status: 'committed', itemUid: original.itemUid,
        version: 8, revisionUid: 'revision', projectionState: 'pending' } } : {}),
    }
    const projected = projectRecordReedit(sparse, [job])
    act(() => { renderer!.update(<ArkmeMessageContent item={projected} sourceRef="source" />) })
    expect(renderer!.root.findAllByType('img')).toHaveLength(0)
    expect(projected).toMatchObject({ recordVersion: 7, version: 5, sendAtMillis: 1 })
  })
})
