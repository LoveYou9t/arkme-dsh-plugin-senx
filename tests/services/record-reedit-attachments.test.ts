import { mkdtemp, rename, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArkmeStateStore } from '../../src/state-store.js'
import { RecordService } from '../../src/services/record-service.js'
import { ArkmeService } from '../../src/arkme-service.js'
import { MediaService } from '../../src/services/media-service.js'
import { ArkmePluginError } from '../../src/services/service.js'

const fileRef = 'arkme-file-v1.11111111-1111-4111-8111-111111111111'
const localFile = { fileRef, fileName: 'new.png', mimeType: 'image/png', size: 12, fileKind: 1 as const }
const asset = { fileAssetUid: 'new-asset', fileName: 'new.png', mimeType: 'image/png', size: 12, fileKind: 1 as const }
const media = (uid: string, sortOrder = 0) => ({ file_asset_uid: uid, render_role: 1, sort_order: sortOrder, file_name: `${uid}.png` })

async function setup(overrides: Record<string, unknown> = {}, onCommitted?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'arkme-attachment-reedit-'))
  const stateStore = new ArkmeStateStore(root)
  let userId = 42
  const core: Record<string, unknown> = {
    record_uid: 'r1', owner_user_id: 42, creator_user_id: 42, origin_kind: 1,
    origin_container_ref: '', template_kind: 2, title: '', text_content: '原文',
    content_payload: { payload_kind: 2, schema_version: 1, text_state: 1, media_refs: [media('a'), media('b', 1)] },
    status: 1, version: 7, content_access_state: 1, ...overrides,
  }
  const writes: Record<string, unknown>[] = []
  const readMedia = vi.fn(async () => ({ items: [{ record_uid: 'r1', items: [
    { file_asset_uid: 'a', file_name: 'a.png', file_kind: 1, mime_type: 'image/png', size: 20, preview_url: 'https://example.com/a.png', download_url: 'https://example.com/a.png' },
    { file_asset_uid: 'b', file_name: 'b.png', file_kind: 1, mime_type: 'image/png', size: 20, preview_url: 'https://example.com/b.png', download_url: 'https://example.com/b.png' },
  ] }] }))
  const update = vi.fn(async (body: Record<string, unknown>) => {
    writes.push(structuredClone(body))
    Object.assign(core, body, { version: Number(core.version) + 1 })
    return { record_core: structuredClone(core), revision_uid: 'revision' }
  })
  const runtime = {
    config: { maxTextLength: 20_000, richMediaSendEnabled: true }, stateStore,
    async requireSession() { return { userId, accessToken: 'access', refreshToken: 'refresh' } },
    async authenticatedPost(path: string, body: Record<string, unknown>) {
      if (path === '/api/v1/records/detail') return { record_core: structuredClone(core) }
      if (path === '/api/v1/records/update') return await update(body)
      if (path === '/api/v1/records/media/batch-list') return await readMedia()
      throw new Error(path)
    },
  }
  const files = {
    files: vi.fn(async () => [localFile]),
    readLocal: vi.fn(async () => ({ file: localFile })),
    uploadRefs: vi.fn(async () => [asset]),
  }
  const mediaService = new MediaService(runtime as never, {} as never, {} as never, { recordUid: raw => (raw as any).record_core?.record_uid ?? '' })
  const restart = (freshState = false) => new RecordService((freshState ? { ...runtime, stateStore: new ArkmeStateStore(root) } : runtime) as never, mediaService, {
    async openSourceRef() { return { version: 1 as const, userId: 42, kind: 'default_category' as const, ownerRef: 'uncategorized', displayName: '未分类' } },
  }, undefined, files, onCommitted)
  const service = restart()
  return { root, stateStore, service, restart, runtime, core, files, writes, update, readMedia, switchAccount: () => { userId = 99 } }
}
const target = { sourceRef: 'source', itemUid: 'r1' }

describe('Record attachment re-edit', () => {
  it('does not refresh after disposal during the completion notification account check', async () => {
    const notify = vi.fn(async () => {})
    const x = await setup({}, notify)
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已保存' })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    const requireSession = x.runtime.requireSession.bind(x.runtime)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      await put(...args)
      if (args[1].state === 'committed') vi.spyOn(x.runtime, 'requireSession').mockImplementationOnce(async () => {
        const session = await requireSession()
        x.service.dispose()
        return session
      })
    })
    await expect(x.service.commitRecordReedit(prepared)).resolves.toMatchObject({ status: 'committed', version: 8 })
    expect(notify).not.toHaveBeenCalled()
  })

  it('clears a completed UI candidate when Tool preparation only refreshes its cache timestamp', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return [asset]
    })
    const candidate = { ...target, newText: '同一候选', expectedVersion: 7, attachments: [{ fileRef }] }
    await x.service.submitRecordReedit(candidate)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const submitted = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    const clock = vi.spyOn(Date, 'now').mockReturnValue(submitted.draft.updatedAtMillis + 1000)
    try {
      const repeated = await x.service.prepareRecordReedit(candidate)
      expect(repeated.draftRevision).toBe(submitted.draft.draftRevision)
    } finally { clock.mockRestore(); release() }
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(await x.stateStore.getRecordReeditDraft(42, submitted.context.sourceIdentityKey, 'r1')).toBeUndefined()
    const next = await x.service.prepareRecordReedit({ ...target, newText: '下一次' })
    expect(next.baseVersion).toBe(8)
    await expect(x.service.commitRecordReedit(next)).resolves.toMatchObject({ status: 'committed', version: 9 })
    expect(x.update).toHaveBeenCalledTimes(2)
  })

  it('settles the previous Tool completion before deriving a subsequent candidate baseline', async () => {
    const x = await setup()
    const first = await x.service.prepareRecordReedit({ ...target, newText: '第一次', expectedVersion: 7, attachments: [] })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    let failOnce = true
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      if (args[1].state === 'committed' && failOnce) { failOnce = false; throw new Error('one local failure') }
      await put(...args)
    })
    await x.service.commitRecordReedit(first)
    const second = await x.service.prepareRecordReedit({ ...target, newText: '第二次' })
    expect(second.baseVersion).toBe(8)
    await expect(x.service.commitRecordReedit(second)).resolves.toMatchObject({ status: 'committed', version: 9 })
    expect(x.update).toHaveBeenCalledTimes(2)
  })
  it('settles a known completed edit before reopening its editor instead of restoring an obsolete draft', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已经保存' })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    let failOnce = true
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      if (args[1].state === 'committed' && failOnce) { failOnce = false; throw new Error('one local failure') }
      await put(...args)
    })
    await x.service.commitRecordReedit(prepared)
    const editor = await x.service.recordReeditEditor('source', 'r1')
    expect(editor.version).toBe(8)
    expect(editor.draft).toBeUndefined()
    expect(x.update).toHaveBeenCalledOnce()
  })
  it.each([false, true])('notifies once through the real Tool facade without reversing success if notification rejects: %s', async rejects => {
    const invalidate = vi.fn(async () => { if (rejects) throw new Error('projection unavailable') })
    const x = await setup({}, invalidate)
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '确认保存' })
    await ArkmeService.prototype.commitRecordReedit.call({ record: x.service, realtime: { invalidateRecordProjection: invalidate } } as never, prepared)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(x.update).toHaveBeenCalledOnce()
  })

  it('keeps a known success while local completion is unavailable and retries only local work', async () => {
    const notify = vi.fn(async () => {})
    const x = await setup({}, notify)
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已成功版本8' })
    let unavailable = true
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      if (args[1].state === 'committed' && unavailable) throw new Error('local completion unavailable')
      return await put(...args)
    })
    await expect(x.service.commitRecordReedit(prepared)).resolves.toMatchObject({ status: 'committed', version: 8 })
    expect((await x.service.recordReeditSubmissions('source'))[0]).toMatchObject({ state: 'committed', result: { version: 8 } })
    expect((await x.stateStore.listRecordReeditSubmissions(42))[0]?.state).toBe('committing')
    expect((await x.stateStore.getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1'))?.textContent).toBe('已成功版本8')
    Object.assign(x.core, { version: 9, text_content: '另一端之后的版本9' })
    unavailable = false
    await x.service.resumeRecordReeditSubmissions('source', true)
    await vi.waitFor(async () => expect((await x.stateStore.listRecordReeditSubmissions(42))[0]).toMatchObject({ state: 'committed', result: { version: 8 } }))
    expect(await x.stateStore.getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1')).toBeUndefined()
    expect(x.update).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledOnce()
  })
  it('rejects an old Tool confirmation after a draft is discarded and recreated', async () => {
    const x = await setup()
    const first = await x.service.prepareRecordReedit({ ...target, newText: 'A'.repeat(170) + '确认内容' })
    const discard = await x.service.prepareDiscardRecordReeditDraft('source', 'r1')
    await x.service.discardRecordReeditDraft(discard)
    await x.service.prepareRecordReedit({ ...target, newText: 'A'.repeat(170) + '未确认新内容' })
    await expect(x.service.commitRecordReedit(first)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    await expect(x.service.discardRecordReeditDraft(discard)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    expect(x.update).not.toHaveBeenCalled()
  })

  it('rejects a deleted-and-recreated draft during the Tool attachment upload window', async () => {
    const x = await setup()
    const first = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, newText: '已确认', attachments: [{ fileRef }] })
    x.files.uploadRefs.mockImplementationOnce(async () => {
      await x.service.discardRecordReeditDraft(await x.service.prepareDiscardRecordReeditDraft('source', 'r1'))
      await x.service.prepareRecordReedit({ ...target, newText: '重建草稿' })
      return [asset]
    })
    await expect(x.service.commitRecordReedit(first)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    expect(x.update).not.toHaveBeenCalled()
  })

  it('persists a Tool write checkpoint and never resends an unknown update after restart', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '等待核对' })
    x.update.mockImplementation(async () => {
      expect((await new ArkmeStateStore(x.root).listRecordReeditSubmissions(42))[0]?.state).toBe('committing')
      throw new ArkmePluginError('network-failed', '未知', false, 502, { writeOutcomeUnknown: true })
    })
    await expect(x.service.commitRecordReedit(prepared)).rejects.toMatchObject({ code: 'record-reedit-outcome-unknown' })
    await expect(x.restart(true).commitRecordReedit(prepared)).rejects.toMatchObject({ code: 'record-reedit-in-progress' })
    expect(x.update).toHaveBeenCalledOnce()
    expect((await new ArkmeStateStore(x.root).listRecordReeditSubmissions(42))[0]?.state).toBe('uncertain')
  })

  it('does not write through Tool if its write-ahead receipt cannot be persisted', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已确认候选' })
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(x.service.commitRecordReedit(prepared)).rejects.toThrow('disk unavailable')
    expect(x.update).not.toHaveBeenCalled()
    expect((await new ArkmeStateStore(x.root).listRecordReeditSubmissions(42))).toHaveLength(0)
  })

  it('rechecks the confirmed Tool draft after checkpoint persistence', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '确认A' })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      await put(...args)
      if (args[1].state === 'committing') await x.service.prepareRecordReedit({ ...target, newText: '后续B' })
    })
    await expect(x.service.commitRecordReedit(prepared)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    expect(x.update).not.toHaveBeenCalled()
    expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed')
  })

  it('does not write when disposed during the final account lookup', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '确认A' })
    let checkpointed = false
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => { await put(...args); checkpointed = true })
    const session = x.runtime.requireSession.bind(x.runtime)
    vi.spyOn(x.runtime, 'requireSession').mockImplementation(async () => {
      const result = await session()
      if (checkpointed) x.service.dispose()
      return result
    })
    await expect(x.service.commitRecordReedit(prepared)).rejects.toMatchObject({ code: 'record-reedit-unavailable' })
    expect(x.update).not.toHaveBeenCalled()
  })

  it('does not let a disposed writer erase a new runtime draft when its response arrives late', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '确认A' })
    const draft = (await x.stateStore.getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1'))!
    const update = x.update.getMockImplementation()!
    x.update.mockImplementationOnce(async body => {
      x.service.dispose()
      await new ArkmeStateStore(x.root).putRecordReeditDraft(42, { ...draft, textContent: '新运行态草稿' })
      return await update(body)
    })
    await expect(x.service.commitRecordReedit(prepared)).resolves.toMatchObject({ status: 'committed' })
    const fresh = new ArkmeStateStore(x.root)
    expect((await fresh.getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1'))?.textContent).toBe('新运行态草稿')
    expect((await fresh.listRecordReeditSubmissions(42))[0]?.state).toBe('committing')
  })

  it('does not save a late prepared draft over a new runtime after disposal', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '原草稿' })
    const draft = (await x.stateStore.getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1'))!
    const session = x.runtime.requireSession.bind(x.runtime)
    let calls = 0
    vi.spyOn(x.runtime, 'requireSession').mockImplementation(async () => {
      const result = await session()
      if (++calls === 2) {
        x.service.dispose()
        await new ArkmeStateStore(x.root).putRecordReeditDraft(42, { ...draft, textContent: '新运行态草稿' })
      }
      return result
    })
    await expect(x.service.prepareRecordReedit({ ...target, newText: '迟到候选' })).rejects.toMatchObject({ code: 'record-reedit-unavailable' })
    expect((await new ArkmeStateStore(x.root).getRecordReeditDraft(42, prepared.sourceIdentityKey, 'r1'))?.textContent).toBe('新运行态草稿')
  })

  it('reconciles a Tool write after final receipt persistence fails without replaying it', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已确认候选' })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      if (args[1].state === 'committed') throw new Error('disk unavailable')
      return await put(...args)
    })
    await expect(x.service.commitRecordReedit(prepared)).resolves.toMatchObject({ status: 'committed' })
    x.service.dispose()
    const recovered = x.restart(true)
    expect((await recovered.recordReeditSubmissions('source'))[0]?.state).toBe('committing')
    await recovered.resumeRecordReeditSubmissions('source', true)
    await vi.waitFor(async () => expect((await recovered.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.update).toHaveBeenCalledOnce()
  })

  it.each(['dispose', 'account'])('does not issue the Tool write after %s during checkpoint persistence', async kind => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已确认候选' })
    const put = x.stateStore.putRecordReeditSubmission.bind(x.stateStore)
    vi.spyOn(x.stateStore, 'putRecordReeditSubmission').mockImplementation(async (...args) => {
      await put(...args)
      if (args[1].state === 'committing') {
        if (kind === 'dispose') x.service.dispose()
        else x.switchAccount()
      }
    })
    await expect(x.service.commitRecordReedit(prepared)).rejects.toMatchObject({ code: kind === 'dispose' ? 'record-reedit-unavailable' : 'record-reedit-account-changed' })
    expect(x.update).not.toHaveBeenCalled()
  })

  it('reports a confirmed Tool write as committed while preserving a newer draft created after that write', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '已确认候选' })
    const update = x.update.getMockImplementation()!
    x.update.mockImplementationOnce(async body => {
      const result = await update(body)
      await x.service.prepareRecordReedit({ ...target, newText: '下一份草稿', expectedVersion: 8 })
      return result
    })
    await expect(x.service.commitRecordReedit(prepared)).resolves.toMatchObject({ status: 'committed', version: 8 })
    expect((await x.service.recordReeditEditor('source', 'r1')).draft?.textContent).toBe('下一份草稿')
    expect(x.writes).toHaveLength(1)
  })

  it('preserves hashtag evidence when editing only attachments', async () => {
    const hashTags = [{ tag: '主题', start_index: 0, length: 3 }]
    const x = await setup({ text_content: '#主题', content_payload: { payload_kind: 2, schema_version: 1, text_state: 1, media_refs: [media('a')], hash_tags: hashTags } })
    const prepared = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    await x.service.commitRecordReedit(prepared)
    expect(x.writes[0]?.content_payload).toMatchObject({ hash_tags: hashTags })
  })

  it('rebuilds hashtag offsets from changed text and clears removed tags', async () => {
    const x = await setup({ template_kind: 1, content_payload: undefined })
    const prepared = await x.service.prepareRecordReedit({ ...target, newText: '😀 #新标签' })
    await x.service.commitRecordReedit(prepared)
    expect(x.writes[0]?.content_payload).toMatchObject({ hash_tags: [{ tag: '新标签', start_index: 3, length: 4 }] })
    const second = await x.service.prepareRecordReedit({ ...target, newText: '不再有标签' })
    await x.service.commitRecordReedit(second)
    expect((x.writes[1]?.content_payload as Record<string, unknown>).hash_tags).toBeUndefined()
  })

  it('does not let the Tool flatten a forward card into an ordinary text record', async () => {
    const x = await setup({ template_kind: 1, content_payload: { payload_kind: 1, schema_version: 1, text_state: 1, forward_records: { source_type: 'record', source_record_uids: ['other-record'] } } })
    await expect(x.service.prepareRecordReedit({ ...target, newText: '修改卡片' })).rejects.toMatchObject({ code: 'record-reedit-shape-unsupported' })
    expect(x.writes).toHaveLength(0)
    expect(x.files.uploadRefs).not.toHaveBeenCalled()
  })

  it('never starts a phantom submission after local persistence fails', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    const context = await x.service.saveRecordReeditDraft({ ...target, expectedVersion: 7, attachments: [] })
    const draft = (await x.stateStore.getRecordReeditDraft(42, context.sourceIdentityKey, 'r1'))!
    await rename(join(x.root, 'state.json'), join(x.root, 'state.backup'))
    await mkdir(join(x.root, 'state.json'))
    await expect(x.stateStore.putRecordReeditSubmission(42, {
      submissionId: 'test', state: 'pending', context, draft, itemUid: 'r1', title: '', textContent: draft.textContent, attachments: [],
    })).rejects.toBeDefined()
    expect(await x.stateStore.listRecordReeditSubmissions(42)).toEqual([])
    expect(x.writes).toHaveLength(0)
  })
  it('deduplicates admission and does not let another submit mutate the in-flight snapshot', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return [asset] })
    const input = { ...target, newText: '第一份', expectedVersion: 7, expectedDraftRevision: 0, attachments: [{ fileRef }] }
    const first = await x.service.submitRecordReedit(input)
    expect((await x.service.submitRecordReedit(input)).submissionId).toBe(first.submissionId)
    await expect(x.service.submitRecordReedit({ ...input, newText: '第二份' })).rejects.toMatchObject({ code: 'record-reedit-in-progress' })
    const saved = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    expect((await x.stateStore.getRecordReeditDraft(42, saved.context.sourceIdentityKey, 'r1'))?.textContent).toBe('第一份')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.writes).toHaveLength(1)
  })

  it('reconciles an interrupted remote write after restart without sending it twice', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    await x.service.submitRecordReedit({ ...target, newText: '保存结果', expectedVersion: 7, attachments: [] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    const job = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    job.state = 'committing'; delete job.result
    await x.stateStore.putRecordReeditSubmission(42, job, job.submissionId)
    const restarted = x.restart()
    await restarted.resumeRecordReeditSubmissions('source')
    await vi.waitFor(async () => expect((await restarted.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.writes).toHaveLength(1)
  })

  it('keeps an interrupted write uncertain when the owner still shows the old version', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new Error('offline'))
    await x.service.submitRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    const job = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    job.state = 'committing'; job.expectedCommittedFingerprint = 'a'.repeat(64)
    await x.stateStore.putRecordReeditSubmission(42, job, job.submissionId)
    const restarted = x.restart()
    await restarted.resumeRecordReeditSubmissions('source')
    await vi.waitFor(async () => expect((await restarted.recordReeditSubmissions('source'))[0]?.state).toBe('uncertain'))
    expect(x.writes).toHaveLength(0)
  })

  it('unblocks recovery when reconciliation proves the owner has a conflicting newer version', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new Error('offline'))
    await x.service.submitRecordReedit({ ...target, newText: '保留候选', expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    const job = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    job.state = 'committing'; job.expectedCommittedFingerprint = 'a'.repeat(64)
    await x.stateStore.putRecordReeditSubmission(42, job, job.submissionId)
    x.core.version = 8
    x.core.text_content = '另一端的新正文'
    const restarted = x.restart()
    await restarted.resumeRecordReeditSubmissions('source')
    await vi.waitFor(async () => expect((await restarted.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    expect((await restarted.recordReeditEditor('source', 'r1')).draft?.textContent).toBe('保留候选')
    expect(x.writes).toHaveLength(0)
    const discard = await restarted.prepareDiscardRecordReeditDraft('source', 'r1')
    await expect(restarted.discardRecordReeditDraft(discard)).resolves.toMatchObject({ status: 'discarded' })
    expect(await restarted.recordReeditSubmissions('source')).toEqual([])
  })

  it('recovers a failed submission candidate even after its editable draft was removed', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new Error('offline'))
    await x.service.submitRecordReedit({ ...target, newText: '不能丢', expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    const job = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    await x.stateStore.removeRecordReeditDraft(42, job.context.sourceIdentityKey, 'r1', job.draft.draftRevision)
    expect((await x.restart().recordReeditEditor('source', 'r1')).draft?.textContent).toBe('不能丢')
  })

  it('does not resurrect a failed candidate after the user explicitly discards it', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new Error('offline'))
    await x.service.submitRecordReedit({ ...target, newText: '放弃这份', expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    const discard = await x.service.prepareDiscardRecordReeditDraft('source', 'r1')
    await x.service.discardRecordReeditDraft(discard)
    expect((await x.service.recordReeditEditor('source', 'r1')).draft).toBeUndefined()
    expect(await x.stateStore.recordReeditFileRefs(42)).not.toContain(fileRef)
  })

  it('preserves a newer draft when the accepted submission finishes', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return [asset] })
    await x.service.submitRecordReedit({ ...target, newText: '已提交', expectedVersion: 7, attachments: [{ fileRef }] })
    const newer = await x.service.saveRecordReeditDraft({ ...target, newText: '后续草稿', expectedVersion: 7, attachments: [] })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.writes[0]?.text_content).toBe('已提交')
    expect((await x.stateStore.getRecordReeditDraft(42, newer.sourceIdentityKey, 'r1'))?.textContent).toBe('后续草稿')
  })
  it('completes without coupling the business result to separate draft cleanup', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    const remove = vi.spyOn(x.stateStore, 'removeRecordReeditDraft').mockRejectedValue(new Error('separate cleanup unavailable'))
    await x.service.submitRecordReedit({ ...target, newText: '服务器已成功', expectedVersion: 7, attachments: [] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(remove).not.toHaveBeenCalled()
    expect(await x.stateStore.getRecordReeditDraft(42, (await x.stateStore.listRecordReeditSubmissions(42))[0]!.context.sourceIdentityKey, 'r1')).toBeUndefined()
    expect(x.writes).toHaveLength(1)
  })
  it('does not let a disposed runtime issue a write after its upload finishes', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return [asset] })
    await x.service.submitRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    x.service.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(x.writes).toHaveLength(0)
    expect((await x.stateStore.listRecordReeditSubmissions(42))[0]?.state).toBe('pending')
    const restarted = x.restart()
    await restarted.resumeRecordReeditSubmissions('source')
    await vi.waitFor(async () => expect((await restarted.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.writes).toHaveLength(1)
  })
  it('releases a committed receipt only after its matching projection is acknowledged', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    const accepted = await x.service.submitRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    await x.service.acknowledgeRecordReeditSubmission('source', accepted.submissionId, 7)
    expect(await x.stateStore.listRecordReeditSubmissions(42)).toHaveLength(1)
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    await x.service.acknowledgeRecordReeditSubmission('source', 'wrong-id', 8)
    expect(await x.stateStore.listRecordReeditSubmissions(42)).toHaveLength(1)
    await x.service.acknowledgeRecordReeditSubmission('source', accepted.submissionId, 8)
    expect(await x.stateStore.listRecordReeditSubmissions(42)).toEqual([])
  })
  it('does not clear a newly recreated draft during recovery of an older commit', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    await x.service.submitRecordReedit({ ...target, newText: '旧提交', expectedVersion: 7, attachments: [] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    const job = (await x.stateStore.listRecordReeditSubmissions(42))[0]!
    job.state = 'committing'; delete job.result
    await x.stateStore.putRecordReeditSubmission(42, job, job.submissionId)
    const newer = await x.stateStore.putRecordReeditDraft(42, { ...job.draft, textContent: '新的未提交草稿', baseVersion: 8 }, 0)
    expect(newer.draftRevision).toBeGreaterThan(1)
    const restarted = x.restart()
    await restarted.resumeRecordReeditSubmissions('source')
    await vi.waitFor(async () => expect((await restarted.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect((await x.stateStore.getRecordReeditDraft(42, job.context.sourceIdentityKey, 'r1'))?.textContent).toBe('新的未提交草稿')
  })
  it('does not allow a Tool commit to race an admitted UI edit of the same record', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    const input = { ...target, expectedVersion: 7, attachments: [{ fileRef }] }
    const tool = await x.service.prepareRecordReedit(input)
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return [asset] })
    await x.service.submitRecordReedit(input)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(x.service.commitRecordReedit(tool)).rejects.toMatchObject({ code: 'record-reedit-in-progress' })
    expect(x.writes).toHaveLength(0)
    release()
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
  })

  it('accepts a durable local submission before uploading or saving remotely', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    let release!: () => void
    x.files.uploadRefs.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return [asset] })
    const accepted = await x.service.submitRecordReedit({ ...target, newText: '立即显示', expectedVersion: 7, attachments: [{ fileRef }] })
    expect(accepted).toMatchObject({ state: 'pending', textContent: '立即显示', itemUid: 'r1' })
    expect(x.writes).toHaveLength(0)
    const restored = new ArkmeStateStore(x.root)
    expect((await restored.listRecordReeditSubmissions(42))[0]?.draft.textContent).toBe('立即显示')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('committed'))
    expect(x.writes).toHaveLength(1)
  })

  it('saves UI drafts locally after opening without another owner detail request', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.core.version = 8
    const saved = await x.service.saveRecordReeditDraft({ ...target, newText: '离线候选', expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }] })
    expect(saved.baseVersion).toBe(7)
    await expect(x.service.commitRecordReedit(saved)).rejects.toMatchObject({ code: 'record-reedit-conflict' })
    expect(x.writes).toHaveLength(0)
  })

  it('retains failed submissions and their files without blocking other drafts', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new Error('上传失败'))
    const accepted = await x.service.submitRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    expect(await x.stateStore.recordReeditFileRefs(42)).toContain(fileRef)
    expect((await x.stateStore.listRecordReeditSubmissions(42))[0]?.submissionId).toBe(accepted.submissionId)
    x.switchAccount()
    expect(await x.stateStore.listRecordReeditSubmissions(99)).toEqual([])
  })

  it('does not mistake an uncertain attachment upload for an uncertain Record update', async () => {
    const x = await setup()
    await x.service.recordReeditEditor('source', 'r1')
    x.files.uploadRefs.mockRejectedValueOnce(new ArkmePluginError('file-upload-unknown', '附件上传结果未知', false, 502, { writeOutcomeUnknown: true }))
    await x.service.submitRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    await vi.waitFor(async () => expect((await x.service.recordReeditSubmissions('source'))[0]?.state).toBe('failed'))
    expect(x.update).not.toHaveBeenCalled()
    expect(await x.stateStore.recordReeditFileRefs(42)).toContain(fileRef)
  })

  it('initializes the owner payload when adding the first attachment to an older text record', async () => {
    const x = await setup({ template_kind: 1, content_payload: undefined })
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    await x.service.commitRecordReedit(p)
    expect(x.writes[0]).toMatchObject({ content_payload: { schema_version: 1, text_state: 1, payload_kind: 2 } })
  })
  it.each([{ content_file_role: 4 }, { binding_type: 4 }])('never drops unsupported background audio metadata: %j', async role => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }] })
    ;(x.core.content_payload as any).media_refs.push({ ...media('background'), ...role })
    await expect(x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })).rejects.toMatchObject({ code: 'record-reedit-shape-unsupported' })
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-shape-unsupported' })
    expect(x.writes).toEqual([])
    expect(await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1')).toBeDefined()
  })
  it('rejects unsupported independent background waveform instead of silently discarding it', async () => {
    const x = await setup({ content_payload: { payload_kind: 2, schema_version: 1, text_state: 1, media_refs: [media('a')], background_sound_amplitudes: [0.2] } })
    await expect(x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })).rejects.toMatchObject({ code: 'record-reedit-shape-unsupported' })
    expect(x.writes).toEqual([])
  })
  it.each(['put', 'migrate'])('does not overwrite a concurrently created attachment draft from legacy %s', async action => {
    const x = await setup({ template_kind: 1, display_kind: 1, content_payload: { payload_kind: 1, schema_version: 1, text_state: 1 } })
    const detail = await x.service.longArticleDetail('source', 'r1')
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(x.service, 'longArticleDetail').mockImplementationOnce(async () => { entered(); await gate; return detail })
    const legacy = { sourceRef: 'source', itemUid: 'r1', title: '', textContent: 'legacy', durationMillis: 0, updatedAtMillis: 1 }
    if (action === 'migrate') await x.stateStore.putLongArticleDraft(42, legacy)
    const pending = action === 'put' ? x.service.putLongArticleDraft(legacy) : x.service.getLongArticleDraft('source', 'r1')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    await started
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    release()
    await rejected
    expect((await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1'))?.attachments).toEqual([])
  })
  it('hydrates original thumbnails through the existing authorized Record media projection', async () => {
    const x = await setup()
    const view = await x.service.recordReeditEditor('source', 'r1')
    expect(x.readMedia).toHaveBeenCalledOnce()
    expect(view.attachments[0]).toMatchObject({ selection: { fileAssetUid: 'a' }, asset: { size: 20, fileName: 'a.png' }, block: { kind: 'image', mediaRef: expect.any(String), originalRef: expect.any(String) } })
    expect(JSON.stringify(view)).not.toContain('https://example.com')
  })
  it('adds, removes and orders attachments without uploading before confirmation', async () => {
    const x = await setup()
    const prepared = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }, { fileAssetUid: 'b' }] })
    expect(x.files.uploadRefs).not.toHaveBeenCalled()
    expect(prepared.attachmentChanges).toEqual({ added: 1, removed: 1, retained: 1, reordered: false })
    await x.service.commitRecordReedit(prepared)
    expect(x.writes[0]).toMatchObject({ text_content: '原文', template_kind: 2, content_payload: {
      payload_kind: 2, media_refs: [{ ...media('new-asset'), file_name: 'new.png' }, media('b', 1)],
    } })
    expect((x.writes[0]!.content_payload as any).media_refs[0].file_name).toBe('new.png')
  })

  it('preserves the attachment candidate when a subsequent text edit omits attachments', async () => {
    const x = await setup()
    await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'b' }] })
    const p = await x.service.prepareRecordReedit({ ...target, newText: '新文' })
    await x.service.commitRecordReedit(p)
    expect((x.writes[0]!.content_payload as any).media_refs).toEqual([media('b')])
  })

  it('clears editable media and returns to plain text', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    await x.service.commitRecordReedit(p)
    expect(x.writes[0]).toMatchObject({ template_kind: 1, content_payload: { payload_kind: 1, media_refs: [] } })
  })

  it('allows attachment-only records but rejects removing their last usable content', async () => {
    const x = await setup({ text_content: '' })
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }] })
    await x.service.commitRecordReedit(p)
    await expect(x.service.prepareRecordReedit({ ...target, expectedVersion: 8, attachments: [] })).rejects.toMatchObject({ code: 'record-reedit-content-invalid' })
  })
  it('marks empty media text unavailable instead of claiming an available text projection', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, newText: '', attachments: [{ fileAssetUid: 'a' }] })
    await x.service.commitRecordReedit(p)
    expect(x.writes[0]).toMatchObject({ text_content: '', content_payload: { text_state: 3 } })
  })
  it('does not silently turn a long article into a media record', async () => {
    const x = await setup({ template_kind: 1, display_kind: 1, content_payload: { payload_kind: 1, schema_version: 1, text_state: 1 } })
    expect((await x.service.recordReeditEditor('source', 'r1')).maxAttachments).toBe(0)
    await expect(x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })).rejects.toMatchObject({ code: 'record-reedit-shape-unsupported' })
    expect(x.files.uploadRefs).not.toHaveBeenCalled()
  })
  it('does not submit duplicate assets when a newly uploaded file resolves to a retained asset', async () => {
    const x = await setup()
    x.files.uploadRefs.mockResolvedValueOnce([{ ...asset, fileAssetUid: 'a' }])
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }, { fileRef }] })
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-attachment-invalid' })
    expect(x.writes).toEqual([])
  })
  it('persists an empty UI draft but refuses to submit it', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, newText: '', attachments: [] }, { draftOnly: true })
    expect((await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1'))?.textContent).toBe('')
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-content-invalid' })
    expect(x.writes).toEqual([])
  })
  it('does not let a legacy long-article consumer drop an attachment draft', async () => {
    const x = await setup({ template_kind: 1, display_kind: 1, content_payload: { payload_kind: 1, schema_version: 1, text_state: 1 } })
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    await expect(x.service.getLongArticleDraft('source', 'r1')).rejects.toMatchObject({ code: 'record-reedit-attachments-editor-required' })
    await expect(x.service.putLongArticleDraft({ sourceRef: 'source', itemUid: 'r1', title: '', textContent: 'legacy', durationMillis: 0, updatedAtMillis: 1 })).rejects.toMatchObject({ code: 'record-reedit-attachments-editor-required' })
    await expect(x.service.removeLongArticleDraft('source', 'r1')).rejects.toMatchObject({ code: 'record-reedit-attachments-editor-required' })
    await expect(x.service.updateLongArticle('source', 'r1', { title: '标题', textContent: 'legacy', version: 7, editDurationMillis: 0 })).rejects.toMatchObject({ code: 'record-reedit-attachments-editor-required' })
    expect((await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1'))?.attachments).toEqual([])
  })

  it.each([
    { attachments: [{ fileAssetUid: 'foreign' }], expectedVersion: 7, code: 'record-reedit-attachment-invalid' },
    { attachments: [{ fileAssetUid: 'a' }, { fileAssetUid: 'a' }], expectedVersion: 7, code: 'record-reedit-attachment-invalid' },
    { attachments: [{ fileAssetUid: 'a', fileRef }], expectedVersion: 7, code: 'record-reedit-attachment-invalid' },
    { attachments: Array.from({ length: 10 }, (_, i) => ({ fileAssetUid: `asset-${i}` })), expectedVersion: 7, code: 'record-reedit-attachment-invalid' },
    { attachments: [{ fileRef: '/tmp/file.png' }], expectedVersion: 7, code: 'record-reedit-attachment-invalid' },
    { attachments: [], expectedVersion: undefined, code: 'record-reedit-version-invalid' },
    { attachments: [], expectedVersion: 6, code: 'record-reedit-conflict' },
  ])('rejects invalid selections or missing/stale baseline: $code', async input => {
    const x = await setup()
    await expect(x.service.prepareRecordReedit({ ...target, ...input } as never)).rejects.toMatchObject({ code: input.code })
    expect(x.writes).toEqual([])
    expect(x.files.uploadRefs).not.toHaveBeenCalled()
  })

  it('keeps a dynamic photo paired and preserves the independent voice while clearing media', async () => {
    const voice = { source_file_asset_uid: 'voice', duration_millis: 1200, transcription_state: 2 }
    const photo = { ...media('still'), dynamic_photo: { logical_uid: 'live', role: 'cover' } }
    const motion = { ...media('motion', 1), render_role: 4, dynamic_photo: { logical_uid: 'live', role: 'motion' } }
    const x = await setup({ template_kind: 4, text_content: '', content_payload: { payload_kind: 4, schema_version: 1, text_state: 2, voice, media_refs: [photo, motion, media('b', 2)] } })
    let p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'still' }] })
    await x.service.commitRecordReedit(p)
    expect((x.writes[0]!.content_payload as any).media_refs).toEqual([photo, motion])
    p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 8, attachments: [] })
    await x.service.commitRecordReedit(p)
    expect(x.writes[1]).toMatchObject({ template_kind: 3, content_payload: { payload_kind: 3, text_state: 2, voice, media_refs: [] } })
  })

  it('persists attachment selections and changes the revision when only order changes', async () => {
    const x = await setup()
    const a = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }, { fileAssetUid: 'b' }] })
    const b = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'b' }, { fileAssetUid: 'a' }] })
    expect(b.draftRevision).toBeGreaterThan(a.draftRevision)
    await expect(x.service.commitRecordReedit(a)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    const restored = await new ArkmeStateStore(x.root).getRecordReeditDraft(42, a.sourceIdentityKey, 'r1')
    expect(restored?.attachments).toEqual([{ fileAssetUid: 'b' }, { fileAssetUid: 'a' }])
    expect((await x.service.recordReeditEditor('source', 'r1')).draft?.attachments?.map(v => v.selection)).toEqual(restored?.attachments)
  })

  it('does not rebase a restored attachment draft onto a newer owner version', async () => {
    const x = await setup()
    await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }] })
    x.core.version = 8
    const p = await x.service.prepareRecordReedit(target)
    expect(p.baseVersion).toBe(7)
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-conflict' })
  })

  it('rejects a stale UI draft revision without overwriting another consumer', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, expectedDraftRevision: 0, attachments: [{ fileAssetUid: 'a' }] })
    await expect(x.service.prepareRecordReedit({ ...target, expectedVersion: 7, expectedDraftRevision: 0, attachments: [] })).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    expect((await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1'))?.attachments).toEqual([{ fileAssetUid: 'a' }])
  })

  it('retains a draft after upload failure and after an account switch during upload', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    x.files.uploadRefs.mockRejectedValueOnce(new Error('upload failed'))
    await expect(x.service.commitRecordReedit(p)).rejects.toThrow('upload failed')
    x.files.uploadRefs.mockImplementationOnce(async () => { x.switchAccount(); return [asset] })
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-account-changed' })
    expect(x.writes).toEqual([])
    expect(await x.stateStore.getRecordReeditDraft(42, p.sourceIdentityKey, 'r1')).toBeDefined()
  })
  it('restores a missing local file as unavailable and allows removing it without losing text', async () => {
    const x = await setup()
    await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, newText: '草稿正文', attachments: [{ fileRef }] })
    x.files.files.mockResolvedValueOnce([])
    const editor = await x.service.recordReeditEditor('source', 'r1')
    expect(editor.draft?.attachments?.[0]).toMatchObject({ selection: { fileRef }, unavailable: true })
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [] })
    await x.service.commitRecordReedit(p)
    expect(x.writes[0]).toMatchObject({ text_content: '草稿正文', template_kind: 1 })
  })

  it('rejects a changed draft after upload instead of applying an obsolete confirmation', async () => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    x.files.uploadRefs.mockImplementationOnce(async () => {
      await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileAssetUid: 'a' }] })
      return [asset]
    })
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-draft-changed' })
    expect(x.writes).toEqual([])
  })
  it.each([false, true])('checks the account after the final draft read before writing (attachments=%s)', async withAttachments => {
    const x = await setup()
    const p = await x.service.prepareRecordReedit({ ...target, newText: '更新', ...(withAttachments ? { expectedVersion: 7, attachments: [{ fileRef }] } : {}) })
    const read = x.stateStore.getRecordReeditDraft.bind(x.stateStore)
    let reads = 0
    vi.spyOn(x.stateStore, 'getRecordReeditDraft').mockImplementation(async (...args) => {
      const draft = await read(...args)
      reads += 1
      if (reads === (withAttachments ? 2 : 1)) x.switchAccount()
      return draft
    })
    await expect(x.service.commitRecordReedit(p)).rejects.toMatchObject({ code: 'record-reedit-account-changed' })
    expect(x.writes).toEqual([])
  })

  it('reconciles an unknown successful write including the changed template and attachments', async () => {
    const x = await setup({ template_kind: 1, content_payload: { payload_kind: 1, schema_version: 1, text_state: 1 } })
    const p = await x.service.prepareRecordReedit({ ...target, expectedVersion: 7, attachments: [{ fileRef }] })
    x.update.mockImplementationOnce(async body => {
      Object.assign(x.core, body, { version: 8 })
      throw new ArkmePluginError('network-failed', '未知结果', false, 502, { writeOutcomeUnknown: true })
    })
    await expect(x.service.commitRecordReedit(p)).resolves.toMatchObject({ status: 'committed', version: 8 })
    expect(x.update).toHaveBeenCalledTimes(1)
  })
})
