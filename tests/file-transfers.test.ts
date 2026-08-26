import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTransfers, type FileTransferPorts } from '../src/services/file-transfers.js'
import { arkmeVisibleUploadFraction } from '../src/file-transfer-contract.js'
import { fileTaskTimelineItem } from '../src/client/file-send-tasks.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arkme files ')); directories.push(directory)
  let user = 42
  const upload = vi.fn<FileTransferPorts['upload']>(async (_path, metadata) => ({ ...metadata, fileAssetUid: `asset-${metadata.fileName}` }))
  const send = vi.fn<FileTransferPorts['send']>(async input => ({ sourceRef: input.sourceRef, itemUid: input.recordUid, status: 1, localState: 'synced' }))
  const ports: FileTransferPorts = { currentUser: async () => user, upload, send, validateSource: async () => {},
    fetchMedia: async () => { throw new Error('unexpected download') } }
  const owner = new FileTransfers(directory, ports, 1000)
  async function stage(name: string) {
    const path = join(directory, name); await writeFile(path, name.padEnd(10, '.'))
    return owner.stage(path, { fileName: name, mimeType: 'application/pdf', size: 10 })
  }
  return { owner, directory, ports, upload, send, stage, setUser: (value: number) => { user = value } }
}
const input = (fileRefs: string[]) => ({ sourceRef: 'source', recordUid: '00000000-0000-4000-8000-000000000001', relationUid: '00000000-0000-4000-8000-000000000002', fileRefs, content: { textContent: 'hello' } })

describe('account-bound file lifecycle', () => {
  it('stages locally without a cloud upload and rejects another account', async () => {
    const f = await fixture(); const file = await f.stage('one.pdf')
    expect(f.upload).not.toHaveBeenCalled()
    expect(JSON.stringify(file)).not.toContain(f.directory)
    expect((await f.owner.readLocal(file.fileRef)).file.size).toBe(10)
    f.setUser(43)
    await expect(f.owner.readLocal(file.fileRef)).rejects.toMatchObject({ code: 'file-ref-invalid' })
  })
  it('retains a successful sibling when another upload fails and retries with the same IDs', async () => {
    const f = await fixture(); const a = await f.stage('a.pdf'); const b = await f.stage('b.pdf')
    f.upload.mockImplementationOnce(async (_path, meta) => ({ ...meta, fileAssetUid: 'uploaded-a' }))
      .mockImplementationOnce(async (_path, _metadata, onProgress) => { onProgress({ phase: 'uploading', sentBytes: 8, totalBytes: 10 }); throw new Error('offline') })
    const task = await f.owner.enqueue(input([a.fileRef, b.fileRef]))
    await f.owner.settled()
    expect((await f.owner.tasks())[0]).toMatchObject({ state: 'failed', files: [{ asset: { fileAssetUid: 'uploaded-a' } }, {}] })
    expect(fileTaskTimelineItem((await f.owner.tasks())[0]!).contentBlocks?.every(block => block.uploadProgress === undefined)).toBe(true)
    expect((await f.owner.retry(task.taskRef)).files[1]!.progress).toMatchObject({ phase: 'preparing', sentBytes: 0 })
    await f.owner.settled()
    expect(f.upload).toHaveBeenCalledTimes(3)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0].recordUid).toBe(task.recordUid)
    expect((await f.owner.tasks())[0]!.state).toBe('sent')
  })
  it('deduplicates repeated acceptance and restores uncertain submissions without resending', async () => {
    const f = await fixture(); const a = await f.stage('a.pdf')
    f.send.mockRejectedValueOnce(new Error('ack lost'))
    const request = input([a.fileRef])
    const task = await f.owner.enqueue(request); await f.owner.settled()
    expect((await f.owner.enqueue(request)).taskRef).toBe(task.taskRef)
    const restored = new FileTransfers(f.directory, f.ports, 1000)
    expect((await restored.tasks())[0]!.state).toBe('uncertain')
    await expect(restored.retry(task.taskRef)).rejects.toMatchObject({ code: 'file-send-uncertain' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not claim completion at the end of a PUT', () => {
    expect(arkmeVisibleUploadFraction({ phase: 'completing', sentBytes: 100, totalBytes: 100 })).toBe(.99)
    expect(arkmeVisibleUploadFraction({ phase: 'ready', sentBytes: 100, totalBytes: 100 })).toBe(1)
  })
  it('reconciles a lost acknowledgement without uploading or sending again', async () => {
    const f = await fixture(); const file = await f.stage('a.pdf')
    f.send.mockRejectedValueOnce(new Error('ack lost'))
    const task = await f.owner.enqueue(input([file.fileRef])); await f.owner.settled()
    f.ports.reconcile = vi.fn(async request => ({ sourceRef: request.sourceRef, itemUid: request.recordUid, status: 1, localState: 'synced' }))
    expect((await f.owner.reconcile(task.taskRef)).state).toBe('sent')
    expect(f.upload).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not interpret absence from a recent page as a rejected send', async () => {
    const f = await fixture(); const file = await f.stage('a.pdf')
    f.send.mockRejectedValueOnce(new Error('ack lost'))
    const task = await f.owner.enqueue(input([file.fileRef])); await f.owner.settled()
    f.ports.reconcile = async () => undefined
    expect((await f.owner.reconcile(task.taskRef)).state).toBe('uncertain')
    await expect(f.owner.retry(task.taskRef)).rejects.toMatchObject({ code: 'file-send-uncertain' })
  })
  it('deduplicates concurrent original reception and never promotes partial files', async () => {
    const f = await fixture()
    const ref = 'arkme-media-v1.fixture'
    let finish!: () => void
    f.ports.fetchMedia = vi.fn(async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { response: new Response('abc', { headers: { 'content-length': '5' } }), descriptor: { fileName: 'a.pdf', mimeType: 'application/pdf', size: 5 } }
    })
    await f.owner.reception(ref, true); await f.owner.reception(ref, true)
    expect(f.ports.fetchMedia).toHaveBeenCalledTimes(1)
    finish(); await f.owner.settled()
    expect(await f.owner.reception(ref)).toMatchObject({ state: 'failed' })
    expect(await f.owner.files()).toEqual([])
    f.ports.fetchMedia = vi.fn(async () => ({ response: new Response('abc'), descriptor: { fileName: 'a.pdf', mimeType: 'application/pdf', size: 3 } }))
    await f.owner.reception(ref, true); await f.owner.settled()
    expect(await f.owner.reception(ref)).toMatchObject({ state: 'ready', file: { size: 3 } })
    await f.owner.reception(ref, true)
    expect(f.ports.fetchMedia).toHaveBeenCalledTimes(1)
    f.setUser(43)
    expect(await f.owner.reception(ref)).toMatchObject({ state: 'missing' })
  })
  it('does not rebind a staged import or queued send to another account', async () => {
    const f = await fixture(); const file = await f.stage('a.pdf')
    const local = await f.owner.readLocal(file.fileRef)
    f.setUser(43)
    await expect(f.owner.stage(local.path, file, 42)).rejects.toMatchObject({ code: 'file-account-changed' })
    expect(await f.owner.files()).toEqual([])
    f.setUser(42)
    f.upload.mockImplementationOnce(async (_path, metadata) => { f.setUser(43); return { ...metadata, fileAssetUid: 'asset-12345678' } })
    await f.owner.enqueue(input([file.fileRef])); await f.owner.settled()
    expect(f.send).not.toHaveBeenCalled()
    f.setUser(42); expect((await f.owner.tasks())[0]!.state).toBe('failed')
  })
  it('accepts bounded bytes instead of arbitrary host paths and validates media headers', async () => {
    const f = await fixture()
    await expect(f.owner.stageBytes('/etc/passwd', { fileName: 'a.txt', mimeType: 'text/plain' })).rejects.toMatchObject({ code: 'file-tool-input-invalid' })
    await expect(f.owner.stageBytes('YWJj', { fileName: 'a.txt', mimeType: 'text/plain\r\nx-test: injected' })).rejects.toMatchObject({ code: 'file-input-invalid' })
    expect(await f.owner.stageBytes('YWJj', { fileName: 'a.txt', mimeType: 'text/plain' })).toMatchObject({ size: 3, fileKind: 4 })
    expect(f.upload).not.toHaveBeenCalled()
  })
  it('guards active references and removes only local tasks and unused files', async () => {
    const f = await fixture(); const file = await f.stage('a.pdf')
    const task = await f.owner.enqueue(input([file.fileRef])); await f.owner.settled()
    await expect(f.owner.remove(file.fileRef)).rejects.toMatchObject({ code: 'file-in-use' })
    await f.owner.discard(task.taskRef); await f.owner.remove(file.fileRef)
    expect(await f.owner.tasks()).toEqual([]); expect(await f.owner.files()).toEqual([])
    expect(f.send).toHaveBeenCalledTimes(1)
  })
})
