import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArkmeFileIcon } from './ArkmeFileIcon.js'
import type { ArkmeContentBlock } from '../types.js'
import type { ArkmeFileReception } from '../file-transfer-contract.js'
import { createArkmeSdk } from '../sdk/index.js'

const sdk = createArkmeSdk()
const receptionListeners = new Map<string, Set<(value: ArkmeFileReception) => void>>()
function publishReception(identity: string, value: ArkmeFileReception) {
  for (const listener of receptionListeners.get(identity) ?? []) listener(value)
}
export const arkmeLocalFileUrl = (ref: string, download = false): string => sdk.localFileUrl(ref, download)
export function arkmeFileSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`
}

export function useArkmeOriginal(block: ArkmeContentBlock, autoReceive = false, refreshKey?: unknown) {
  const identity = block.localFileRef ?? block.originalRef ?? block.mediaRef
  const [snapshot, setSnapshot] = useState<{ identity: string; value: ArkmeFileReception }>()
  const reception: ArkmeFileReception = snapshot?.identity === identity ? snapshot.value : { state: 'missing', receivedBytes: 0, totalBytes: block.size }
  const [revision, setRevision] = useState(0)
  const [requested, setRequested] = useState<string>()
  useEffect(() => {
    if (block.localFileRef !== undefined) return
    let active = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setSnapshot({ identity, value: { state: 'missing', receivedBytes: 0, totalBytes: block.size } })
    if (block.originalRef === undefined) return
    const listeners = receptionListeners.get(identity) ?? new Set<(value: ArkmeFileReception) => void>()
    const update = (value: ArkmeFileReception) => { if (active) setSnapshot({ identity, value }) }
    listeners.add(update); receptionListeners.set(identity, listeners)
    const poll = async (start: boolean) => {
      try {
        const value = await sdk.receiveFile(block.originalRef!, start, controller.signal)
        if (!active) return
        publishReception(identity, value)
        if (value.state === 'receiving') timer = setTimeout(() => { void poll(false) }, 750)
      } catch (error) {
        if (active) setSnapshot({ identity, value: { state: 'failed', receivedBytes: 0, totalBytes: block.size, error: error instanceof Error ? error.message : '文件接收失败' } })
      }
    }
    void poll(autoReceive || requested === identity)
    return () => {
      active = false; controller.abort(); if (timer !== undefined) clearTimeout(timer)
      listeners.delete(update); if (listeners.size === 0) receptionListeners.delete(identity)
    }
  }, [identity, block.originalRef, block.localFileRef, block.size, autoReceive, requested, revision, refreshKey])
  const localRef = block.localFileRef ?? reception.file?.fileRef
  return { reception, localRef, receive: () => { setRequested(identity); setRevision(value => value + 1) } }
}

type SavePickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> }

const primaryActionStyle: CSSProperties = { padding: '10px 24px', border: 0, borderRadius: 8, background: 'var(--dsw-alias-state-business-primary, #3964fe)', color: 'white', fontSize: 14, cursor: 'pointer' }

function FileReceptionProgress({ reception, fileName }: { reception: ArkmeFileReception; fileName: string }) {
  const percent = reception.totalBytes > 0 ? Math.max(0, Math.min(100, Math.round(reception.receivedBytes / reception.totalBytes * 100))) : undefined
  return <div style={{ width: 220, maxWidth: '100%', margin: '8px 0' }}>
    <div role="status" style={{ color: 'var(--dsw-alias-label-tertiary, #9097a1)', fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
      {percent === undefined ? '正在接收文件' : `正在接收文件 ${percent}%`}
    </div>
    <div role="progressbar" aria-label={`接收 ${fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      style={{ position: 'relative', height: 4, borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--dsw-alias-state-business-primary, #3964fe)', opacity: .16 }} />
      {percent !== undefined && <div style={{ position: 'relative', height: '100%', width: `${percent}%`, borderRadius: 'inherit', background: 'var(--dsw-alias-state-business-primary, #3964fe)', transition: 'width 180ms ease-out' }} />}
    </div>
  </div>
}

/** Browser fallback deliberately reports handoff, not an unverifiable disk-save success. */
function useArkmeFileDownload(block: ArkmeContentBlock, original: ReturnType<typeof useArkmeOriginal>) {
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveController = useRef<AbortController>()
  const { localRef } = original
  useEffect(() => () => { saveController.current?.abort() }, [block.mediaRef, block.localFileRef])
  useEffect(() => { setNotice(''); setSaved(false) }, [block.mediaRef, block.localFileRef])
  const save = async () => {
    if ((localRef === undefined && block.originalRef === undefined) || saving) return
    const controller = new AbortController(); saveController.current = controller
    setSaving(true); setNotice('')
    try {
      const picker = (window as SavePickerWindow).showSaveFilePicker
      // Choose a destination first. Cancelling must not start reception or fetch bytes.
      const handle = picker === undefined ? undefined : await picker.call(window, { suggestedName: block.fileName })
      controller.signal.throwIfAborted()
      let saveRef = localRef
      if (saveRef === undefined) {
        let value = await sdk.receiveFile(block.originalRef!, true, controller.signal)
        const deadline = Date.now() + 120_000
        publishReception(block.originalRef!, value)
        while (value.state === 'receiving' || value.state === 'missing') {
          if (Date.now() >= deadline) throw new Error('接收文件超时，请重试')
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(controller.signal.reason) }
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 750)
            controller.signal.addEventListener('abort', abort, { once: true })
            if (controller.signal.aborted) abort()
          })
          value = await sdk.receiveFile(block.originalRef!, false, controller.signal)
          publishReception(block.originalRef!, value)
        }
        if (value.state !== 'ready' || value.file === undefined) throw new Error(value.error ?? '原文件不可用')
        saveRef = value.file.fileRef
      }
      controller.signal.throwIfAborted()
      if (handle !== undefined) {
        const response = await fetch(arkmeLocalFileUrl(saveRef), { signal: controller.signal })
        if (!response.ok) throw new Error('原文件已不可用，请重新接收')
        const writable = await handle.createWritable()
        try { const data = await response.blob(); controller.signal.throwIfAborted(); await writable.write(data); await writable.close() }
        catch (error) { await writable.abort().catch(() => {}); throw error }
        setNotice('保存成功'); setSaved(true)
      } else {
        const link = document.createElement('a')
        link.href = arkmeLocalFileUrl(saveRef, true); link.download = block.fileName
        document.body.append(link); link.click(); link.remove()
        setNotice('已交给浏览器下载')
      }
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '保存失败，请重试')
    } finally { setSaving(false) }
  }
  return { notice, saving, saved, save }
}

function FileDownloadAction({ block, original, download, primary = false }: {
  block: ArkmeContentBlock; original: ReturnType<typeof useArkmeOriginal>; download: ReturnType<typeof useArkmeFileDownload>; primary?: boolean
}) {
  const { reception, localRef } = original
  const { notice, saving, saved, save } = download
  return <div style={{ display: 'flex', flexDirection: primary ? 'column' : 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 10, fontSize: 12 }}>
    {(!saved || primary) && <button type="button" aria-label="下载文件" title="下载文件" disabled={saving || (localRef === undefined && block.originalRef === undefined)} onClick={() => { void save() }}
      style={primary ? { ...primaryActionStyle, cursor: saving ? 'progress' : 'pointer' } : { width: 30, height: 30, border: 0, padding: 0, borderRadius: '50%', background: 'rgba(255,255,255,.16)', color: 'inherit', cursor: saving ? 'progress' : 'pointer' }}>
      {primary ? (saving ? '正在下载…' : '下载') : <svg width="31" height="30" viewBox="0 0 31 30" fill="none" aria-hidden>
        <path d="M8.90625 17V19C8.90625 20.1046 9.80168 21 10.9063 21H20.9063C22.0108 21 22.9062 20.1046 22.9062 19V17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15.9102 8V17.5M15.9102 17.5L12.9102 14.5M15.9102 17.5L18.9102 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>}
    </button>}
    {saving && !primary && <span role="status">{reception.state === 'receiving' ? '正在接收文件' : '正在下载…'}</span>}
    {reception.error && <span role="alert">{reception.error}</span>}
    {notice && <span role="status">{notice}</span>}
  </div>
}

export function ArkmeFileActions({ block, original }: { block: ArkmeContentBlock; original: ReturnType<typeof useArkmeOriginal> }) {
  const download = useArkmeFileDownload(block, original)
  return <FileDownloadAction block={block} original={original} download={download} />
}

export function ArkmeFileViewer({ block, onClose, blocks = [block], onSelect, openLocalFile = false }: {
  block: ArkmeContentBlock; onClose: () => void; blocks?: ArkmeContentBlock[]; onSelect?: (block: ArkmeContentBlock) => void; openLocalFile?: boolean
}) {
  const original = useArkmeOriginal(block, block.kind === 'image')
  const download = useArkmeFileDownload(block, original)
  const panel = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [openRequested, setOpenRequested] = useState(openLocalFile)
  const url = original.localRef === undefined ? undefined : arkmeLocalFileUrl(original.localRef)
  const textFile = /\.(md|markdown|txt|csv|log)$/i.test(block.fileName) && block.size <= 2 * 1024 * 1024
  const browserPreview = textFile || block.mimeType === 'application/pdf' || /^(image|video|audio)\//.test(block.mimeType) && block.mimeType !== 'image/svg+xml'
  const showContent = url !== undefined && browserPreview && (openRequested || block.kind === 'image' || block.kind === 'video')
  const primaryDownload = original.localRef !== undefined && !browserPreview
  const index = Math.max(0, blocks.findIndex(value => value.mediaRef === block.mediaRef))
  useEffect(() => { setOpenRequested(openLocalFile); setError('') }, [block.mediaRef, openLocalFile])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => { previous?.focus() }
  }, [])
  useEffect(() => {
    setText(''); setError('')
    if (url === undefined || !textFile || !showContent) return
    const controller = new AbortController()
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('文件预览失败')
      const value = await response.text()
      if (!controller.signal.aborted) setText(value)
    }).catch(() => { if (!controller.signal.aborted) setError('文件预览失败，请下载后打开') })
    return () => controller.abort()
  }, [url, textFile, showContent])
  const open = () => {
    setOpenRequested(browserPreview); setError('')
    if (original.localRef === undefined) original.receive()
  }
  const mediaStyle = { width: '100%', maxHeight: '65vh', objectFit: 'contain' as const }
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 11000, background: 'rgba(0,0,0,.72)', display: 'grid', placeItems: 'center', padding: 24 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`文件预览 ${block.fileName}`} style={{ position: 'relative', width: showContent ? 'min(860px, 90vw)' : 'min(420px, 90vw)', maxHeight: '80vh', borderRadius: 16, padding: showContent ? '56px 20px 20px' : '48px 40px 32px', color: 'var(--dsw-alias-label-primary, #17191c)', background: 'var(--dsw-alias-bg-elevated, white)' }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],video[controls],audio[controls]')
        const first = focusable?.[0]; const last = focusable?.[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <button type="button" aria-label="关闭文件预览" onClick={onClose} style={{ position: 'absolute', right: 12, top: 12, width: 32, height: 32, padding: 0, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-secondary, #646b76)', cursor: 'pointer' }}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      {!showContent ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 16 }}>
        <ArkmeFileIcon fileName={block.fileName} mimeType={block.mimeType} size={64} />
        <div style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{block.fileName}</div>
        <div style={{ fontSize: 14, color: 'var(--dsw-alias-label-tertiary, #9097a1)' }}>文件大小：{arkmeFileSize(block.size)}</div>
        {original.reception.state === 'receiving' && original.localRef === undefined
          ? <FileReceptionProgress reception={original.reception} fileName={block.fileName} />
          : primaryDownload ? <FileDownloadAction block={block} original={original} download={download} primary />
            : <button type="button" onClick={open} disabled={original.localRef === undefined && block.originalRef === undefined} style={primaryActionStyle}>{original.localRef === undefined ? '接收文件' : '预览'}</button>}
        {original.reception.error && <p role="alert">{original.reception.error}</p>}
      </div>
        : block.mimeType.startsWith('image/') && block.mimeType !== 'image/svg+xml' ? <img src={url} alt={block.fileName} style={mediaStyle} />
          : block.mimeType.startsWith('video/') ? <video src={url} controls style={mediaStyle} />
            : block.mimeType.startsWith('audio/') ? <audio src={url} controls />
              : textFile ? <div style={{ maxHeight: '65vh', overflow: 'auto', overflowWrap: 'anywhere' }}>{/\.(md|markdown)$/i.test(block.fileName) ? <MarkdownText text={text} /> : <pre style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>}</div>
                : block.mimeType === 'application/pdf' ? <iframe title={block.fileName} src={url} sandbox="" style={{ width: '100%', height: '60vh', border: 0 }} />
                  : null}
      {error && <p role="alert">{error}</p>}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: -56, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
        {onSelect !== undefined && blocks.length > 1 && <><button type="button" aria-label="上一个文件" disabled={index === 0} onClick={() => onSelect(blocks[index - 1]!)} style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 24 }}>‹</button><button type="button" aria-label="下一个文件" disabled={index === blocks.length - 1} onClick={() => onSelect(blocks[index + 1]!)} style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 24 }}>›</button></>}
        {!primaryDownload && <FileDownloadAction block={block} original={original} download={download} />}
      </div>
    </div>
  </div>, document.body)
}
