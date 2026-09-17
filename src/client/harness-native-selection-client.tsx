import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { Component, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArkmeMessageSelectionControl, ArkmeSelectActionIcon, messageSelectionMenuStyles } from './message-selection-presentation.js'
import { arkmeTheme } from './arkme-theme.js'
import { EMPTY_NATIVE_SELECTION, nativeSelectionReducer, observeSelectedNativeNodes, readNativeChat, type NativeChat } from './harness-native-selection.js'
import { watchNativeSelectionGeometry, observeNativeChatPresence, nativeSelectionContextRow, type NativeSelectionLayout } from './harness-native-selection-geometry.js'
import type {} from './harness-slots-contract.js'

const SLOT = 'conversation.session.header.actions'
const buttonStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 6, padding: '5px 8px', background: 'transparent', color: arkmeTheme.text, cursor: 'pointer', font: 'inherit' } as const
const EMPTY_LAYOUT: NativeSelectionLayout = { seats: [], cramped: false, viewport: null }
type HeaderProps = {
  sessionId: string
  useChat?: SnapshotSelectorHook<unknown>
}

class SelectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('Arkme native selection disabled after a rendering error.') }
  render() { return this.state.failed ? <span role="status">多选暂不可用</span> : this.props.children }
}

export function NativeSelectionHeader({ sessionId, useChat, doc = document }: HeaderProps & { doc?: Document }) {
  if (typeof useChat !== 'function') return null
  return <SelectionBoundary key={sessionId}><NativeSelectionView useChat={useChat} doc={doc} /></SelectionBoundary>
}

function NativeSelectionView({ useChat, doc }: { useChat: SnapshotSelectorHook<unknown>; doc: Document }) {
  const [present, setPresent] = useState(false)
  useLayoutEffect(() => observeNativeChatPresence(doc, setPresent), [doc])
  return present ? <NativeSelectionSession useChat={useChat} doc={doc} /> : null
}

function NativeSelectionSession({ useChat, doc }: { useChat: SnapshotSelectorHook<unknown>; doc: Document }) {
  const snapshot = useChat(value => value)
  const chat = readNativeChat(snapshot)
  const chatRef = useRef<NativeChat | undefined>(chat)
  chatRef.current = chat
  const [state, dispatch] = useReducer(nativeSelectionReducer, EMPTY_NATIVE_SELECTION)
  const [layout, setLayout] = useState(EMPTY_LAYOUT)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  const entry = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ key: string; row: HTMLElement; x: number; y: number } | null>(null)
  const restoreFocus = useRef(false)
  const watcher = useRef<ReturnType<typeof watchNativeSelectionGeometry> | undefined>(undefined)
  const fail = () => { setMenu(null); dispatch({ type: 'exit' }); setLayout(EMPTY_LAYOUT); setFailed(true) }

  useLayoutEffect(() => {
    const surface = doc.defaultView?.frameElement?.parentElement
    if (surface?.getAttribute('data-arkme-owned') !== 'deepseek-harness-surface') return
    let account = surface.getAttribute('data-arkme-account-scope')
    let accountId = surface.getAttribute('data-arkme-account-id')
    const sync = () => {
      const next = surface.getAttribute('data-arkme-visible') === 'true'
      const nextAccount = surface.getAttribute('data-arkme-account-scope')
      const nextAccountId = surface.getAttribute('data-arkme-account-id')
      if (!next || nextAccount !== account || nextAccountId !== accountId) { setMenu(null); dispatch({ type: 'exit' }) }
      account = nextAccount
      accountId = nextAccountId
      setVisible(next)
    }
    const observer = new MutationObserver(sync)
    observer.observe(surface, { attributes: true, attributeFilter: ['data-arkme-visible', 'data-arkme-account-scope', 'data-arkme-account-id'] })
    const exit = () => { setMenu(null); dispatch({ type: 'exit' }) }
    doc.defaultView!.addEventListener('pagehide', exit)
    sync()
    return () => { observer.disconnect(); doc.defaultView!.removeEventListener('pagehide', exit) }
  }, [doc])

  useLayoutEffect(() => {
    if (!state.active || !visible || failed) return
    if (!chatRef.current) { fail(); return }
    try {
      watcher.current = watchNativeSelectionGeometry({
        doc,
        chat: () => { if (!chatRef.current) throw new Error('Native chat contract changed'); return chatRef.current },
        publish: setLayout,
        fail,
      })
    } catch { fail() }
    return () => { watcher.current?.dispose(); watcher.current = undefined; setLayout(EMPTY_LAYOUT) }
  }, [state.active, visible, failed, doc])
  useLayoutEffect(() => {
    if (!layer.current) return
    // A zero-size layer belongs to native scroll content; controls scroll with it.
    const origin = layer.current.getBoundingClientRect()
    layer.current.style.setProperty('--arkme-selection-origin-x', `${origin.left}px`)
    layer.current.style.setProperty('--arkme-selection-origin-y', `${origin.top}px`)
    layer.current.style.visibility = 'visible'
  }, [layout])
  useLayoutEffect(() => {
    if (!state.active && restoreFocus.current) { entry.current?.focus(); restoreFocus.current = false }
  }, [state.active])
  useEffect(() => { watcher.current?.refresh() }, [snapshot])
  useEffect(() => {
    if (!chat || !state.active) return
    try { return observeSelectedNativeNodes(chat, state.keys, key => dispatch({ type: 'remove', key }), fail) }
    catch { fail() }
  }, [chat?.nodes, state.active, state.keys])

  useEffect(() => {
    if (!visible || failed || !chat) return
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || state.active) return
      try {
        const target = nativeSelectionContextRow(doc, event.target, chat)
        if (!target) return
        event.preventDefault(); event.stopPropagation()
        entry.current = doc.activeElement instanceof doc.defaultView!.HTMLElement ? doc.activeElement : null
        setMenu({ ...target, x: Math.max(8, Math.min(event.clientX, doc.defaultView!.innerWidth - 186)), y: Math.max(8, Math.min(event.clientY, doc.defaultView!.innerHeight - 56)) })
      } catch { fail() }
    }
    doc.addEventListener('contextmenu', open)
    return () => doc.removeEventListener('contextmenu', open)
  }, [visible, failed, chat, state.active, doc])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const outside = (event: MouseEvent) => {
      if (!(event.target instanceof doc.defaultView!.Element) || !event.target.closest('[data-arkme-native-selection="menu"]')) close()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); entry.current?.focus() }
    }
    doc.addEventListener('mousedown', outside)
    doc.addEventListener('keydown', keydown, true)
    doc.defaultView!.addEventListener('resize', close)
    doc.addEventListener('scroll', close, true)
    return () => {
      doc.removeEventListener('mousedown', outside); doc.removeEventListener('keydown', keydown, true)
      doc.defaultView!.removeEventListener('resize', close); doc.removeEventListener('scroll', close, true)
    }
  }, [menu, doc])

  if (!visible) return null
  if (failed || !chat) return <span role="status">多选暂不可用</span>
  const exit = () => { restoreFocus.current = true; dispatch({ type: 'exit' }) }
  const escape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open], [role="menu"]')) return
    event.stopPropagation(); exit()
  }
  return <>
    {state.active && <div data-arkme-native-selection="header" onKeyDown={escape} style={{ display: 'flex', alignItems: 'center', gap: 6, color: arkmeTheme.text, fontSize: 12 }}>
        <span role="status" aria-live="polite">已选 {state.keys.size} 条</span>
        {layout.cramped && <span role="status" style={{ color: arkmeTheme.secondary }}>请扩大窗口以勾选消息</span>}
        <button type="button" style={buttonStyle} onClick={exit}><ArkmeSelectActionIcon kind="close" size={16} />退出</button>
    </div>}
    {menu && createPortal(<div data-arkme-native-selection="menu" role="menu" aria-label="消息操作" style={{ ...messageSelectionMenuStyles.menu, left: menu.x, top: menu.y }}>
      <button autoFocus type="button" role="menuitem" style={messageSelectionMenuStyles.menuButton} onClick={() => {
        setMenu(null)
        try {
          const target = nativeSelectionContextRow(doc, menu.row, chat)
          if (target?.key === menu.key) dispatch({ type: 'enter', key: menu.key })
        } catch { fail() }
      }}><span style={messageSelectionMenuStyles.menuIcon}><ArkmeSelectActionIcon kind="select" size={16} /></span>多选</button>
    </div>, doc.body)}
    {state.active && layout.viewport && createPortal(<div ref={layer} data-arkme-native-selection="controls" onKeyDown={escape}
      style={{ position: 'relative', width: 0, height: 0, overflowAnchor: 'none', pointerEvents: 'none', zIndex: 20 }}>
      <style>{'[data-arkme-native-selection] button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #8295e8); outline-offset: 2px; }'}</style>
      {!layout.cramped && layout.seats.map(seat => <div key={seat.key} data-arkme-native-selection-key={seat.key}
        style={{ position: 'absolute', left: `calc(${seat.left}px - var(--arkme-selection-origin-x, 0px))`, top: `calc(${seat.top}px - var(--arkme-selection-origin-y, 0px))`, pointerEvents: 'auto' }}>
        <ArkmeMessageSelectionControl anchor="card-center" checked={state.keys.has(seat.key)} disabled={false} onToggle={() => {
          try {
            if (watcher.current?.valid(seat)) dispatch({ type: 'toggle', key: seat.key })
            else watcher.current?.refresh()
          } catch { fail() }
        }} />
      </div>)}
    </div>, layout.viewport)}
  </>
}

/** Register through a public additive slot; never replace native message renderers. */
export function install(ctx: ClientContext, doc: Document = document): () => void {
  if (typeof ctx.slots?.spec !== 'function') return () => {}
  return ctx.slots.inject(SLOT, () => {
    try {
      const spec = ctx.slots.spec(SLOT)
      if (spec?.kind !== 'list' || spec.scope !== 'session') return () => {}
      return ctx.slots.register({ name: SLOT, id: 'arkme-native-selection', order: 10 },
        (props: HeaderProps) => <NativeSelectionHeader {...props} doc={doc} />)
    } catch {
      console.warn('Arkme native selection slot unavailable.')
      return () => {}
    }
  })
}
