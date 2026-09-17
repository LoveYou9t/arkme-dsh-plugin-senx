import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArkmeRecordEditHistoryPage, ArkmeRecordEditHistoryReader } from '../record-edit-history.js'
import { ArkmeMessageContent } from './ArkmeRichContent.js'
import { callArkme } from './api.js'
import { arkmeTheme } from './arkme-theme.js'

const historyReader: ArkmeRecordEditHistoryReader = {
  page: (sourceRef, messageActionRef, cursorEditAt, signal) => callArkme<ArkmeRecordEditHistoryPage>(
    'source.record-edit-history', { sourceRef, messageActionRef, cursorEditAt }, signal,
  ),
}
const actionStyle = { border: `1px solid ${arkmeTheme.borderSoft}`, borderRadius: 6, padding: '6px 12px', background: arkmeTheme.base, color: arkmeTheme.text, cursor: 'pointer' } as const
const emptyPage: ArkmeRecordEditHistoryPage = { items: [], hasMore: false }

/** Local read lifecycle only: no draft, mutation, timeline cache or persistent state. */
export function ArkmeRecordEditHistory({ sourceRef, messageActionRef, reader = historyReader }: {
  sourceRef: string
  messageActionRef: string
  reader?: ArkmeRecordEditHistoryReader
}) {
  const [page, setPage] = useState(emptyPage)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController>()
  const busyRef = useRef(false)
  const cursorRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    clearTimeout(timerRef.current)
    busyRef.current = false
  }, [])
  const load = useCallback((cursor: number) => {
    if (busyRef.current) return
    busyRef.current = true
    cursorRef.current = cursor
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    const read = async (emptyRetries: number): Promise<void> => {
      try {
        const result = await reader.page(sourceRef, messageActionRef, cursor, controller.signal)
        if (controller.signal.aborted) return
        // Only retry an actually empty first page. An all-filtered page with a
        // continuation must retain the owner's cursor, not restart at page one.
        if (cursor === 0 && result.items.length === 0 && !result.hasMore && emptyRetries < 2) {
          timerRef.current = setTimeout(() => { void read(emptyRetries + 1) }, 500)
          return
        }
        setPage(previous => {
          const items = cursor === 0 ? result.items : [...new Map([...previous.items, ...result.items].map(item => [item.revisionUid, item])).values()]
          return { ...result, items }
        })
        cursorRef.current = result.hasMore ? result.nextCursorEditAt ?? 0 : 0
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : '编辑记录暂不可用')
      }
      if (!controller.signal.aborted) {
        busyRef.current = false
        setLoading(false)
      }
    }
    void read(0)
  }, [sourceRef, messageActionRef, reader])
  useEffect(() => {
    cancel()
    cursorRef.current = 0
    setPage(emptyPage)
    load(0)
    return cancel
  }, [load, cancel])
  return <div aria-busy={loading} data-arkme-edit-history="true">
      {page.items.map((revision, index) => <section key={revision.revisionUid} style={{ marginBottom: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 12, color: arkmeTheme.tertiary, fontSize: 12 }}>
          <time dateTime={new Date(revision.editAtMillis).toISOString()}>{new Date(revision.editAtMillis).toLocaleString('zh-CN')}</time>
          {index === 0 && <span style={{ marginLeft: 8 }}>最新</span>}
        </div>
        {(revision.content.title || revision.content.textContent || revision.content.contentBlocks.length > 0 || !revision.content.mediaUnavailable) && <ArkmeMessageContent presentation="detail" item={{
          ...revision.content, mediaUnavailable: false, itemUid: revision.revisionUid, senderName: '', isMe: false,
          sendAtMillis: revision.editAtMillis, status: 1,
        }} />}
        {revision.content.mediaUnavailable === true && <p style={{ color: arkmeTheme.tertiary, fontSize: 12 }}>部分历史附件暂不可用</p>}
      </section>)}
      {loading && <p role="status" style={{ color: arkmeTheme.tertiary }}>正在加载编辑记录…</p>}
      {error !== '' && <div role="alert"><p>{error}</p><button type="button" style={actionStyle} onClick={() => { load(cursorRef.current) }}>重试</button></div>}
      {!loading && error === '' && page.items.length === 0 && !page.hasMore && <p style={{ color: arkmeTheme.tertiary }}>暂无编辑记录</p>}
      {!loading && error === '' && page.items.some(item => item.content.mediaUnavailable === true) && <button type="button" style={actionStyle} onClick={() => { load(0) }}>重新加载历史附件</button>}
      {!loading && error === '' && page.hasMore && <button type="button" style={actionStyle} onClick={() => { load(cursorRef.current) }}>加载更多</button>}
    </div>
}
