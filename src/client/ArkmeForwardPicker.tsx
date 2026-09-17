import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ArkmeSourceItem, ArkmeSourceList, ArkmeSourceSendResult } from '../types.js'
import { arkmeSourceAllowsUserWrite } from '../topic-policy.js'
import { callArkme, ArkmeClientError } from './api.js'
import { arkmeTheme } from './arkme-theme.js'
import { ArkmeSelectActionIcon } from './message-selection-presentation.js'
import { arkmeSourceIdentityKey } from './source-identity.js'

export interface ForwardRequestIdentity {
  requestId: string
  recordUid: string
  commentRecordUid: string
  sendAtMillis: number
}
export interface ArkmeForwardDelivery {
  send(target: ArkmeSourceItem, identity: ForwardRequestIdentity, comment: string, signal: AbortSignal): Promise<ArkmeSourceSendResult>
}

function errorMessage(error: unknown): string {
  return error instanceof ArkmeClientError ? error.body.message : error instanceof Error ? error.message : '转发失败，请重试'
}
function targetMeta(source: ArkmeSourceItem): string {
  return source.kind === 'private_chat' ? '私聊' : source.kind === 'group_chat' ? '群聊' : source.kind === 'topic' ? '主题' : '发给自己'
}
const targetKey = (target: ArkmeSourceItem) => `${target.kind}:${target.kind === 'send_to_self' || target.kind === 'default_category' ? target.kind : arkmeSourceIdentityKey(target)}`

type Directory = 'root' | 'send_to_self'
const DIRECTORIES: readonly Directory[] = ['root', 'send_to_self']
interface DirectoryPage { items: ArkmeSourceItem[]; loading: boolean; error: string; cursor: string | undefined }
const emptyPage = (): DirectoryPage => ({ items: [], loading: true, error: '', cursor: undefined })
const directoryLabel = (directory: Directory) => directory === 'root' ? '聊天对象' : '自己与主题'

const styles: Record<string, CSSProperties> = {
  closeButton: { width: 34, height: 34, flex: 'none', display: 'grid', placeItems: 'center', padding: 0, border: 0, background: 'transparent', color: arkmeTheme.text, cursor: 'pointer' },
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1750, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 18, boxSizing: 'border-box', background: 'rgba(23,25,28,.34)',
  },
  dialog: {
    width: 'min(520px, 100%)', maxHeight: 'min(680px, calc(100vh - 36px))', display: 'flex', flexDirection: 'column',
    borderRadius: 12, background: arkmeTheme.layer2, boxShadow: '0 20px 54px rgba(23,25,28,.22)', overflow: 'hidden',
  },
  dialogHeader: { display: 'flex', alignItems: 'center', padding: '16px 18px', borderBottom: `1px solid ${arkmeTheme.border}` },
  dialogTitle: { flex: 1, margin: 0, fontSize: 17, lineHeight: '24px' },
  input: { margin: '12px 16px 4px', padding: '9px 11px', border: `1px solid ${arkmeTheme.border}`, borderRadius: 8, background: arkmeTheme.input, color: arkmeTheme.text },
  targetList: { flex: 1, minHeight: 140, overflowY: 'auto', padding: '8px 12px' },
  target: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', border: 0, borderRadius: 8, background: 'transparent', color: arkmeTheme.text, textAlign: 'left', cursor: 'pointer' },
  targetCheck: { width: 20, height: 20, display: 'grid', placeItems: 'center', border: `1px solid ${arkmeTheme.border}`, borderRadius: 6 },
  dialogFooter: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: `1px solid ${arkmeTheme.border}` },
  dialogButton: { minWidth: 72, height: 34, padding: '0 14px', border: `1px solid ${arkmeTheme.border}`, borderRadius: 8, background: arkmeTheme.elevated, color: arkmeTheme.text, cursor: 'pointer' },
  primary: { border: 0, background: arkmeTheme.accent, color: '#fff' },
}

/** Shared target UI. Source identity and delivery remain owned by the caller. */
export function ArkmeForwardPicker({ open = true, delivery, onClose, onComplete, onStatus, onForwarded }: {
  open?: boolean
  delivery: ArkmeForwardDelivery
  onClose(): void
  onComplete(): void
  onStatus(message: string): void
  onForwarded?: (target: ArkmeSourceItem, result: ArkmeSourceSendResult) => void
}) {
  const [pages, setPages] = useState<Record<Directory, DirectoryPage>>({ root: emptyPage(), send_to_self: emptyPage() })
  const targets = [...new Map(Object.values(pages).flatMap(page => page.items).map(target => [targetKey(target), target])).values()]
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [comment, setComment] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const busy = useRef(false)
  const closed = useRef(false)
  const loadRequests = useRef<Partial<Record<Directory, AbortController>>>({})
  const sendRequest = useRef<AbortController>()
  const ids = useRef(new Map<string, ForwardRequestIdentity>())
  const completed = useRef(new Set<string>())
  const frozenComment = useRef<string>()

  const load = async (directory: Directory, more = false) => {
    if (busy.current) return
    loadRequests.current[directory]?.abort()
    const request = new AbortController(); loadRequests.current[directory] = request
    const cursor = more ? pages[directory].cursor : undefined
    const timeout = setTimeout(() => request.abort(), 30_000)
    setPages(current => ({ ...current, [directory]: { ...current[directory], loading: true, error: '' } }))
    try {
      const page = await callArkme<ArkmeSourceList>('sources.list', { directory, limit: 80, ...(cursor ? { cursor } : {}) }, request.signal)
      request.signal.throwIfAborted()
      if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error('转发对象分页暂不可用，请重试')
      if (!closed.current && loadRequests.current[directory] === request) setPages(current => {
        const unique = new Map((more ? current[directory].items : []).map(target => [targetKey(target), target]))
        for (const target of page.items) {
          if (arkmeSourceAllowsUserWrite(target) && ['private_chat', 'group_chat', 'send_to_self', 'default_category', 'topic'].includes(target.kind)) unique.set(targetKey(target), target)
        }
        return { ...current, [directory]: { items: [...unique.values()], loading: false, error: '', cursor: page.hasMore ? page.nextCursor : undefined } }
      })
    } catch (reason) {
      if (!closed.current && loadRequests.current[directory] === request) setPages(current => ({ ...current,
        [directory]: { ...current[directory], loading: false, error: request.signal.aborted ? '转发对象加载超时' : errorMessage(reason) },
      }))
    } finally { clearTimeout(timeout) }
  }
  useEffect(() => {
    if (!open) return
    closed.current = false
    const previous = dialog.current?.ownerDocument.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    // Keep already selected targets and their access refs when resuming the same attempt.
    for (const directory of DIRECTORIES) if (pages[directory].items.length === 0 || pages[directory].loading) void load(directory, Boolean(pages[directory].cursor))
    return () => {
      closed.current = true
      Object.values(loadRequests.current).forEach(request => request.abort())
      sendRequest.current?.abort()
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  const send = async () => {
    if (busy.current || selected.length === 0) return
    const pending = targets.filter(target => selected.includes(targetKey(target)) && !completed.current.has(targetKey(target)))
    if (pending.length === 0) return
    busy.current = true; setSending(true); setSubmitted(true); setError('')
    frozenComment.current ??= comment.trim()
    const request = new AbortController(); sendRequest.current = request
    const timeout = setTimeout(() => request.abort(), 30_000)
    try {
      const results = await Promise.allSettled(pending.map(async target => {
        const key = targetKey(target)
        let identity = ids.current.get(key)
        if (!identity) {
          identity = { requestId: crypto.randomUUID(), recordUid: crypto.randomUUID(), commentRecordUid: crypto.randomUUID(), sendAtMillis: Date.now() }
          ids.current.set(key, identity)
        }
        const result = await delivery.send(target, identity, frozenComment.current!, request.signal)
        if (result.localState !== 'synced' || !result.itemUid) throw new Error('转发结果未确认，请使用原请求重试')
        return result
      }))
      if (closed.current) return
      const failures: string[] = []; const warnings: string[] = []
      let successCount = 0
      results.forEach((result, index) => {
        const target = pending[index]!
        if (result.status === 'rejected') { failures.push(targetKey(target)); return }
        successCount++
        if (result.value.warningText?.trim()) warnings.push(targetKey(target))
        else completed.current.add(targetKey(target))
        try { onForwarded?.(target, result.value) } catch { /* A confirmed delivery is not retried for a projection callback. */ }
      })
      if (failures.length || warnings.length) {
        setSelected([...failures, ...warnings])
        const warning = results.find((r): r is PromiseFulfilledResult<ArkmeSourceSendResult> => r.status === 'fulfilled' && Boolean(r.value.warningText?.trim()))
        const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        const message = failures.length ? successCount ? `已转发 ${successCount} 个目标，${failures.length} 个失败，可重试` : request.signal.aborted ? '转发超时，请使用原请求重试' : errorMessage(rejected?.reason) : warning?.value.warningText ?? '转发已完成，附言发送失败'
        setError(message)
        onStatus(failures.length && successCount ? `已转发 ${successCount} 个目标，${failures.length} 个失败` : message)
      } else {
        onStatus(`已转发到 ${completed.current.size} 个目标`)
        onComplete()
      }
    } finally {
      clearTimeout(timeout); busy.current = false
      if (!closed.current) setSending(false)
    }
  }
  if (!open) return null
  const close = () => { if (!busy.current) onClose() }
  const filtered = targets.filter(target => !keyword.trim() || `${target.displayName} ${targetMeta(target)}`.toLowerCase().includes(keyword.trim().toLowerCase()))
  return <div data-arkme-forward-picker="true" style={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) close() }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])]
      const current = dialog.current?.ownerDocument.activeElement
      const first = controls[0]; const last = controls.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (current === first || !controls.includes(current as HTMLElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (current === last || !controls.includes(current as HTMLElement))) { event.preventDefault(); first.focus() }
    }
  }}>
    <section ref={dialog} style={styles.dialog} role="dialog" aria-modal="true" aria-label="选择转发对象">
      <header style={styles.dialogHeader}><h3 style={styles.dialogTitle}>转发给</h3><button type="button" aria-label="关闭转发对象选择" style={styles.closeButton} disabled={sending} onClick={close}><ArkmeSelectActionIcon kind="close" size={16} /></button></header>
      <input style={styles.input} value={keyword} placeholder="搜索" aria-label="搜索转发对象" disabled={sending} onChange={event => setKeyword(event.target.value)} />
      <div style={styles.targetList}>
        {filtered.map(target => {
          const key = targetKey(target); const checked = selected.includes(key)
          return <button key={key} type="button" style={styles.target} disabled={sending || completed.current.has(key)} onClick={() => {
            if (busy.current || completed.current.has(key)) return
            if (!checked && selected.length >= 5) { onStatus('最多选择 5 个转发对象'); return }
            setSelected(checked ? selected.filter(value => value !== key) : [...selected, key]); setError('')
          }}><span style={{ ...styles.targetCheck, background: checked ? arkmeTheme.accent : 'transparent', color: checked ? '#fff' : arkmeTheme.text }}>{checked ? '✓' : ''}</span><span style={{ flex: 1 }}><strong>{target.displayName}</strong><small style={{ display: 'block', color: arkmeTheme.secondary }}>{completed.current.has(key) ? '已转发' : targetMeta(target)}</small></span></button>
        })}
        {DIRECTORIES.map(directory => <div key={directory}>
          {pages[directory].loading && <div>{directoryLabel(directory)}正在加载…</div>}
          {pages[directory].error && <div role="alert">{directoryLabel(directory)}：{pages[directory].error}<button type="button" disabled={sending} onClick={() => { void load(directory, Boolean(pages[directory].cursor)) }}>重新加载</button></div>}
          {!pages[directory].loading && !pages[directory].error && pages[directory].cursor && <button type="button" disabled={sending} onClick={() => { void load(directory, true) }}>加载更多{directoryLabel(directory)}</button>}
        </div>)}
        {!Object.values(pages).some(page => page.loading || page.error) && filtered.length === 0 && <div>{keyword.trim() ? '已加载对象中没有匹配结果' : '暂无可转发对象'}</div>}
        {error && <div style={{ color: arkmeTheme.danger, padding: 8 }}>{error}</div>}
      </div>
      <textarea style={{ ...styles.input, minHeight: 58, resize: 'vertical' }} value={comment} placeholder="附言（可选）" disabled={sending || submitted} onChange={event => setComment(event.target.value)} />
      <footer style={styles.dialogFooter}><button type="button" style={styles.dialogButton} disabled={sending} onClick={close}>取消</button><button type="button" style={{ ...styles.dialogButton, ...styles.primary, opacity: selected.length === 0 || sending ? .45 : 1 }} disabled={!selected.length || sending} onClick={() => { void send() }}>{sending ? '转发中…' : '转发'}</button></footer>
    </section>
  </div>
}
