import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArkmeRecordReeditSubmissionView } from '../record-reedit-contract.js'
import type { ArkmeTimelineItem } from '../types.js'
import { callArkme } from './api.js'
import { localFileBlock } from './file-send-tasks.js'

export function projectRecordReedit(item: ArkmeTimelineItem, jobs: readonly ArkmeRecordReeditSubmissionView[]): ArkmeTimelineItem {
  const job = jobs.find(value => value.itemUid === item.itemUid)
  const version = item.recordVersion ?? item.version ?? 0
  if (!job || (job.result ? version >= job.result.version : version > job.baseVersion)) return item
  return {
    ...item, title: job.title, textContent: job.textContent,
    // The candidate supplies the complete media selection, including explicit removal.
    mediaUnavailable: false,
    contentBlocks: [
      ...(item.contentBlocks ?? []).filter(block => job.voiceFileAssetUid && block.fileAssetUid === job.voiceFileAssetUid),
      ...job.attachments.flatMap((attachment, index) => {
        const block = attachment.localFile ? localFileBlock(attachment.localFile, index) : attachment.block ?? {
          kind: 'file' as const, mediaRef: '', fileName: attachment.asset.fileName,
          mimeType: attachment.asset.mimeType, size: attachment.asset.size, sortOrder: index,
        }
        return block ? [{ ...block, sortOrder: index }] : []
      }),
    ],
  }
}

/** Activates Host recovery explicitly; subsequent polling only reads receipts. */
export function useRecordReeditSubmissions(sourceRef: string | undefined, accountKey: string | undefined, active: boolean) {
  const key = JSON.stringify([sourceRef, accountKey, active])
  const scope = useRef({ key, generation: 0 })
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1 }
  const generation = scope.current.generation
  const revision = useRef(0)
  const [snapshot, setSnapshot] = useState<{ key: string; generation: number; jobs: ArkmeRecordReeditSubmissionView[] }>({ key, generation, jobs: [] })
  const refresh = useCallback(async (reconcile = false) => {
    if (!sourceRef || !accountKey || !active) return
    const started = revision.current
    if (reconcile) await callArkme('source.record-reedit.resume', { sourceRef, reconcile: true })
    const jobs = await callArkme<ArkmeRecordReeditSubmissionView[]>('source.record-reedit.submissions', { sourceRef })
    if (scope.current.generation !== generation || scope.current.key !== key || started !== revision.current || !Array.isArray(jobs)) return
    setSnapshot({ key, generation, jobs })
  }, [sourceRef, accountKey, active, key, generation])
  useEffect(() => {
    let disposed = false
    let resumed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!resumed) {
        try {
          await callArkme('source.record-reedit.resume', { sourceRef })
          resumed = true
        } catch { /* Retry activation without hiding already available receipts. */ }
      }
      if (disposed) return
      try {
        await refresh()
      } catch { /* Retain known receipts when the read is temporarily unavailable. */ }
      if (!disposed) timer = setTimeout(() => { void poll() }, 1500)
    }
    if (active && sourceRef && accountKey) void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [refresh, active, sourceRef, accountKey])
  const accepted = useCallback((job: ArkmeRecordReeditSubmissionView) => {
    if (scope.current.key !== key || scope.current.generation !== generation) return
    revision.current += 1
    setSnapshot(previous => ({ key, generation, jobs: [...(previous.key === key && previous.generation === generation ? previous.jobs : []).filter(value => value.itemUid !== job.itemUid), job] }))
  }, [key, generation])
  return { jobs: snapshot.key === key && snapshot.generation === generation ? snapshot.jobs : [], accepted, refresh }
}
