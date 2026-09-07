import { describe, expect, it } from 'vitest'
import { projectRecordReedit } from '../src/client/record-reedit-submissions.js'
import type { ArkmeRecordReeditSubmissionView } from '../src/record-reedit-contract.js'
import type { ArkmeTimelineItem } from '../src/types.js'

const original: ArkmeTimelineItem = { itemUid: 'r', title: '', textContent: '旧文', version: 7, sendAtMillis: 1, status: 1 }
const pending: ArkmeRecordReeditSubmissionView = { submissionId: 's', itemUid: 'r', state: 'pending', baseVersion: 7, title: '', textContent: '新文', attachments: [{ localFile: { fileRef: 'local', fileName: 'new.png', mimeType: 'image/png', fileKind: 1, size: 10 }, selection: { fileRef: 'local' } }] }
describe('re-edit presentation is not a canonical record', () => {
  it('updates text and attachments together without inventing a version or send time', () => {
    expect(projectRecordReedit(original, [pending])).toMatchObject({ itemUid: 'r', textContent: '新文', version: 7, sendAtMillis: 1, contentBlocks: [{ localFileRef: 'local' }] })
  })
  it('never masks a newer canonical version while a conflicting edit is pending', () => {
    const newer = { ...original, version: 8, textContent: '其他设备更新' }
    expect(projectRecordReedit(newer, [pending])).toBe(newer)
  })
  it('retains the successful candidate until its version reaches the timeline', () => {
    const committed = { ...pending, state: 'committed' as const, result: { status: 'committed' as const, itemUid: 'r', version: 8, revisionUid: 'revision', projectionState: 'pending' as const } }
    expect(projectRecordReedit(original, [committed]).textContent).toBe('新文')
    const projected = { ...original, version: 8, textContent: '新文' }
    expect(projectRecordReedit(projected, [committed])).toBe(projected)
  })
  it('preserves only the independent voice, not a removed ordinary audio attachment', () => {
    const audio = (uid: string) => ({ kind: 'audio' as const, mediaRef: uid, fileAssetUid: uid, fileName: uid, mimeType: 'audio/mp3', size: 10, sortOrder: 0 })
    const item = { ...original, contentBlocks: [audio('voice'), audio('ordinary-audio')] }
    expect(projectRecordReedit(item, [{ ...pending, attachments: [], voiceFileAssetUid: 'voice' }]).contentBlocks).toEqual([audio('voice')])
  })
})
