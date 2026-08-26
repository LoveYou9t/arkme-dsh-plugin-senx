import { describe, expect, it } from 'vitest'
import { ArkmeComposerDraftStore, arkmeSourceComposerDraftKey } from '../src/client/composer-draft-store.js'
import { fileTaskTimelineItem } from '../src/client/file-send-tasks.js'

describe('local file draft recovery', () => {
  it('keeps the same send IDs after a lost acceptance response and page refresh', () => {
    let saved = ''
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }
    const key = arkmeSourceComposerDraftKey(42, { kind: 'group_chat', sourceRef: 'source' })!
    const store = new ArkmeComposerDraftStore(storage)
    store.appendAttachments(key, [{ localFile: { fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000001', fileName: 'a.md', mimeType: 'text/markdown', size: 10, fileKind: 4 } }])
    store.setText(key, '文件消息')
    const identity = store.beginFileSend(key)
    expect(store.beginFileSend(key)).toEqual(identity)
    const restored = new ArkmeComposerDraftStore(storage)
    expect(restored.beginFileSend(key)).toEqual(identity)
    restored.setText(key, '另一条明确的新内容')
    expect(restored.beginFileSend(key).recordUid).not.toBe(identity.recordUid)
  })
  it('persists local references and ordering, omits object URLs, and clears on logout', () => {
    let saved = ''
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }
    const key = arkmeSourceComposerDraftKey(42, { kind: 'group_chat', sourceRef: 'source' })!
    const store = new ArkmeComposerDraftStore(storage)
    const first = { fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000001', fileName: 'a.md', mimeType: 'text/markdown', size: 10, fileKind: 4 as const }
    const second = { ...first, fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000002', fileName: 'b.md' }
    store.setText(key, '草稿'); store.appendAttachments(key, [{ localFile: first, previewUrl: 'blob:secret' }, { localFile: second }])
    store.moveAttachment(key, 1, 0)
    expect(saved).not.toContain('blob:')
    const restored = new ArkmeComposerDraftStore(storage)
    expect(restored.isRestored(key)).toBe(true)
    expect(restored.get(key).attachments.map(item => item.localFile?.fileName)).toEqual(['b.md', 'a.md'])
    expect(restored.get(key).text).toBe('草稿')
    restored.setText(key, '新草稿'); expect(restored.isRestored(key)).toBe(false)
    restored.clearAccount(42)
    expect(new ArkmeComposerDraftStore(storage).get(key).attachments).toEqual([])
  })
  it('projects an accepted task as local file cards instead of an empty message', () => {
    const file = { fileRef: 'arkme-file-v1.00000000-0000-4000-8000-000000000001', fileName: 'a.pdf', mimeType: 'application/pdf', size: 10, fileKind: 4 as const, progress: { phase: 'completing' as const, sentBytes: 10, totalBytes: 10 } }
    expect(fileTaskTimelineItem({ taskRef: 'task', sourceRef: 'source', recordUid: 'record', relationUid: 'relation', content: { textContent: '正文' }, fileRefs: [file.fileRef], files: [file], state: 'uploading', createdAtMillis: 123 })).toMatchObject({ itemUid: 'record', textContent: '正文', contentBlocks: [{ localFileRef: file.fileRef, kind: 'file', uploadProgress: { phase: 'completing' } }] })
  })
})
