import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './slots-contract.js'
import type { ArkmeSourceItem, ArkmeSourceList } from '../types.js'
import { ArkmeOutgoingCallHost } from './ArkmeOutgoingCallHost.js'
import { ArkmeProductNavigation } from './ArkmeProductNavigation.js'
import { ArkmeSurface } from './ArkmeSidebar.js'
import { ArkmeNavigation } from './ArkmeVirtualWorkspace.js'
import arkmeNavigationLogoBase64 from '../../assets/branding/arkme-navigation-logo.png'
import arkmeNavigationLogoDarkBase64 from '../../assets/branding/arkme-navigation-logo-dark.png'
import type { ArkmeDshMessageSearchResult } from './ArkmeSearchSurface.js'
import { ContactDirectorySurface } from './redesign/contacts/ContactDirectorySurface.js'
import { DirectoryDetailPane } from './redesign/contacts/DirectoryDetailPane.js'
import { UnmarkedSpeakerDetail } from './redesign/contacts/UnmarkedSpeakerDetail.js'
import { arkmeContactsTab } from './redesign/contacts/contacts-tab-store.js'
import { callArkme } from './api.js'
import { DeepSeekHarnessSurface } from './DeepSeekHarnessSurface.js'
import { startupAuthGateEnabled } from './ArkmeStartupAuthGate.js'
import { arkmeAuthStore } from './auth-store.js'
import { arkmeChatDirectory } from './chat-directory-store.js'
import { useArkmeRealtimeClientEvents } from './realtime-client-events.js'
import { arkmeUi } from './ui-controller.js'
import { ARKME_LOGIN_LOCALE_NAMESPACE } from './arkme-login-locales.js'

const styles: Record<string, CSSProperties> = {
  sidebar: {
    position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0,
    display: 'flex', overflow: 'hidden', background: '#fff',
  },
  webLoginSidebar: {
    width: 72, minWidth: 72, height: '100%', padding: '28px 8px 14px', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    borderRight: '1px solid #e7e7e9', background: '#fff', color: '#3e4149',
  },
  webLoginBrand: { display: 'grid', width: 48, height: 28, placeItems: 'center' },
  webLoginBrandImage: { display: 'block', width: 48, height: 28, objectFit: 'cover' },
  webLoginButton: {
    width: '100%', minHeight: 57, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 5, padding: '7px 4px', border: 0, borderRadius: 15, background: '#f1f2f6', color: '#151722',
    cursor: 'pointer', font: 'inherit', fontSize: 11, lineHeight: '15px', fontWeight: 500,
  },
  taskDirectory: { minWidth: 0, flex: 1, overflow: 'hidden', borderLeft: '1px solid #ececef', background: '#fff' },
  sidebarResizeHandle: {
    position: 'absolute', zIndex: 3, top: 0, right: 0, bottom: 0, width: 10,
    cursor: 'col-resize', touchAction: 'none',
  },
  workspace: {
    width: '100%', height: '100%', minWidth: 0, minHeight: 0,
    overflow: 'hidden', background: '#fff', position: 'relative',
  },
  conversationLayer: {
    position: 'absolute', inset: 0, minWidth: 0, minHeight: 0,
  },
  details: { width: 0, height: 0, overflow: 'hidden' },
}

// The DSH layout width covers the legacy sidebar seat; Arkme adds its 72px navigation rail plus its divider budget.
const ARKME_PERSISTENT_SIDEBAR_CHROME_WIDTH = 76
const ARKME_PERSISTENT_SIDEBAR_MIN_WIDTH = 72
const ARKME_PERSISTENT_SIDEBAR_MAX_WIDTH = 480
const ARKME_PERSISTENT_SIDEBAR_AVATAR_ONLY_WIDTH = 120

function clampPersistentSidebarWidth(width: number): number {
  return Math.min(ARKME_PERSISTENT_SIDEBAR_MAX_WIDTH, Math.max(ARKME_PERSISTENT_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/** Permanent browser-side lifecycles that used to be owned by the optional DSH footer entry. */
export function ArkmePersistentClientRuntime() {
  const ui = useSyncExternalStore(arkmeUi.subscribe, arkmeUi.getSnapshot, arkmeUi.getSnapshot)
  const authState = useSyncExternalStore(arkmeAuthStore.subscribe, arkmeAuthStore.getSnapshot, arkmeAuthStore.getSnapshot)
  const auth = authState.auth

  useArkmeRealtimeClientEvents(auth, ui.authRevision, true)

  return <ArkmeOutgoingCallHost />
}

export type ArkmePersistentSidebarProps = PropsRuntime<'sidebar'>
  & PropsRenderSlots<'arkme.directory.entry'>
  & {
    collapseSidebar(): void
    closeDetails(): void
    searchDshMessages?(query: string, signal: AbortSignal): Promise<{ items: SessionSearchResultItem[]; hasMore: boolean }>
    openDshSession?(sessionId: string): void
  }

/** Arkme permanently owns the DSH sidebar seat so navigation stays stable across Arkme and Harness conversations. */
export function ArkmePersistentSidebar({
  collapsed, width, useSessions, renderSlot, collapseSidebar, closeDetails,
  searchDshMessages = async () => ({ items: [], hasMore: false }), openDshSession = () => undefined,
}: ArkmePersistentSidebarProps) {
  const sessionState = useSessions(state => state)
  const ui = useSyncExternalStore(arkmeUi.subscribe, arkmeUi.getSnapshot, arkmeUi.getSnapshot)
  const authState = useSyncExternalStore(arkmeAuthStore.subscribe, arkmeAuthStore.getSnapshot, arkmeAuthStore.getSnapshot)
  const harnessMode = ui.mode === 'harness'
  const loginMode = ui.mode === 'login'
    || (authState.auth !== undefined && authState.auth.status !== 'authenticated')
  const webLoginMode = loginMode && !startupAuthGateEnabled()
  const authenticatedUserId = authState.auth?.status === 'authenticated' ? authState.auth.userId : undefined
  const contactsAccountKey = authState.auth?.status === 'authenticated' ? `${authState.auth.environment}:${String(authState.auth.userId)}` : undefined
  const contacts = useSyncExternalStore(arkmeContactsTab.subscribe, arkmeContactsTab.getSnapshot, arkmeContactsTab.getSnapshot)
  const scopedContacts = arkmeContactsTab.getSnapshotForAccount(contactsAccountKey)
  const contactsDirectoryCache = arkmeContactsTab.getDirectoryCache(contactsAccountKey)
  const contactsMode = ui.mode === 'source' && ui.productMode === 'contacts'
  const handoffControllerRef = useRef<AbortController>()
  const contactsContextRef = useRef({ accountKey: contactsAccountKey, contactsMode })
  contactsContextRef.current = { accountKey: contactsAccountKey, contactsMode }
  const [sendToSelfState, setSendToSelfState] = useState<{
    userId: number
    source: ArkmeSourceItem
  }>()
  const directoryVisible = !loginMode && ui.calendarOpen !== true
    && (ui.mode === 'source' || ui.mode === 'bot' || ui.mode === 'arko' || harnessMode)
  const [sidebarWidthOverride, setSidebarWidthOverride] = useState<number>()
  const sidebarResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number }>()
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const renderedSidebarWidth = sidebarWidthOverride ?? width + ARKME_PERSISTENT_SIDEBAR_CHROME_WIDTH
  const avatarOnly = !contactsMode && renderedSidebarWidth <= ARKME_PERSISTENT_SIDEBAR_AVATAR_ONLY_WIDTH
  useEffect(() => {
    if (authenticatedUserId === undefined) {
      setSendToSelfState(undefined)
      return
    }
    const controller = new AbortController()
    void callArkme<ArkmeSourceList>('sources.list', {
      directory: 'send_to_self', limit: 100,
    }, controller.signal).then(page => {
      const source = page.items.find(item => item.kind === 'send_to_self')
      if (source !== undefined && !controller.signal.aborted) {
        setSendToSelfState({ userId: authenticatedUserId, source })
      }
    }).catch(() => undefined)
    return () => controller.abort()
  }, [authenticatedUserId, ui.recordRevision])
  const sendToSelfSource = sendToSelfState !== undefined && sendToSelfState.userId === authenticatedUserId
    ? sendToSelfState.source
    : undefined
  const searchDsh = useCallback(async (query: string, signal: AbortSignal): Promise<ArkmeDshMessageSearchResult> => {
    const result = await searchDshMessages(query, signal)
    return {
      hasMore: result.hasMore,
      items: result.items.map(item => {
        const summary = sessionState.byId[item.sessionId]
        return {
          sessionId: item.sessionId,
          title: summary?.displayTitle ?? 'DeepSeek Harness 任务',
          snippet: item.snippet,
          updatedAtMillis: summary?.updatedAt ?? 0,
        }
      }),
    }
  }, [searchDshMessages, sessionState.byId])
  useLayoutEffect(() => {
    closeDetails()
    if (collapsed) collapseSidebar()
  }, [closeDetails, collapseSidebar, collapsed])
  useLayoutEffect(() => { arkmeContactsTab.activateAccount(contactsAccountKey) }, [contactsAccountKey])
  useEffect(() => arkmeContactsTab.bindAborter(() => { handoffControllerRef.current?.abort() }), [])
  useEffect(() => {
    if (!contactsMode) handoffControllerRef.current?.abort()
  }, [contactsMode, contactsAccountKey, contacts.generation])
  useEffect(() => () => { handoffControllerRef.current?.abort() }, [])

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: renderedSidebarWidth }
    setSidebarResizing(true)
  }, [renderedSidebarWidth])
  const continueSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = sidebarResizeRef.current
    if (resize === undefined || resize.pointerId !== event.pointerId) return
    setSidebarWidthOverride(clampPersistentSidebarWidth(resize.startWidth + event.clientX - resize.startX))
  }, [])
  const stopSidebarResize = useCallback((element?: HTMLDivElement, pointerId?: number) => {
    if (pointerId !== undefined && element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    sidebarResizeRef.current = undefined
    setSidebarResizing(false)
  }, [])

  if (loginMode) return webLoginMode ? <aside
    data-arkme-owned="persistent-sidebar"
    data-arkme-login-mode="true"
    data-arkme-login-entry
    data-arkme-directory-visible="false"
    style={styles.webLoginSidebar}
    aria-label="Arkme 登录入口"
  >
    <span style={styles.webLoginBrand} aria-hidden>
      <img
        src={`data:image/png;base64,${arkmeNavigationLogoBase64}`}
        data-arkme-theme-image="light"
        draggable={false}
        style={styles.webLoginBrandImage}
      />
      <img
        src={`data:image/png;base64,${arkmeNavigationLogoDarkBase64}`}
        data-arkme-theme-image="dark"
        draggable={false}
        style={styles.webLoginBrandImage}
      />
    </span>
    <button type="button" style={styles.webLoginButton} onClick={() => { arkmeUi.showLogin() }}>
      登录 Arkme
    </button>
  </aside> : <aside
    data-arkme-owned="persistent-sidebar"
    data-arkme-login-mode="true"
    data-arkme-directory-visible="false"
    style={{ ...styles.sidebar, width: 0 }}
    aria-hidden
  />

  return <aside
    data-arkme-owned="persistent-sidebar"
    data-arkme-workspace
    data-arkme-sidebar-collapsed={collapsed ? 'true' : 'false'}
    data-arkme-harness-mode={harnessMode ? 'true' : 'false'}
    data-arkme-directory-visible={directoryVisible ? 'true' : 'false'}
    data-arkme-sidebar-resizing={sidebarResizing ? 'true' : 'false'}
    data-arkme-login-mode="false"
    {...(contactsMode ? { 'data-arkme-contacts-mobile-view': scopedContacts.selection.kind !== 'none' ? 'content' : 'directory' } : {})}
    style={styles.sidebar}
    aria-label="Arkme 功能导航栏"
  >
    {!collapsed && directoryVisible && <style data-arkme-owned="persistent-sidebar-resize-handle-style">{`
      :root { --arkme-persistent-sidebar-width: ${String(renderedSidebarWidth)}px; }
      :root:has([data-arkme-owned="persistent-sidebar"]) [data-side="sidebar"] {
        left: ${String(renderedSidebarWidth)}px !important;
        pointer-events: none;
      }
      :root:has([data-arkme-owned="persistent-sidebar"][data-arkme-sidebar-resizing="true"]) [data-slot="root"] > div,
      :root:has([data-arkme-owned="persistent-sidebar"][data-arkme-sidebar-resizing="true"]) [data-side="sidebar"] {
        transition: none !important;
      }
    `}</style>}
    <ArkmeProductNavigation
      compact={false}
      hosted
      taskExpanded
      hidden={avatarOnly}
      currentSessionId={sessionState.current}
    />
    {directoryVisible && <div style={styles.taskDirectory} data-arkme-directory-mode={contactsMode ? 'contacts' : 'conversations'}>
      {contactsMode ? <ContactDirectorySurface
        accountKey={contactsAccountKey ?? ''} selection={scopedContacts.selection} refreshRevision={scopedContacts.refreshRevision}
        expandedSections={scopedContacts.expandedSections}
        {...(contactsDirectoryCache === undefined ? {} : {
          initialState: contactsDirectoryCache.state,
          cacheFresh: contactsDirectoryCache.fresh,
        })}
        onStateChange={(state, refreshed) => { arkmeContactsTab.cacheDirectoryState(state, refreshed) }}
        onSelectionChange={selection => { arkmeContactsTab.activateAccount(contactsAccountKey); arkmeContactsTab.select(selection) }}
        onExpandedChange={(section, expanded) => { arkmeContactsTab.setSectionExpanded(section, expanded) }}
        onOpenGroup={sourceRef => {
          arkmeContactsTab.activateAccount(contactsAccountKey)
          handoffControllerRef.current?.abort()
          const controller = new AbortController()
          handoffControllerRef.current = controller
          const generation = arkmeContactsTab.getSnapshot().generation
          const accountKey = contactsAccountKey
          void callArkme<ArkmeSourceItem>('directory.group.open-chat', { sourceRef }, controller.signal)
            .then(source => {
              const current = arkmeContactsTab.getSnapshot()
              const currentUi = arkmeUi.getSnapshot()
              const context = contactsContextRef.current
              if (controller.signal.aborted || current.generation !== generation || current.accountKey !== accountKey
                || context.accountKey !== accountKey || !context.contactsMode
                || currentUi.mode !== 'source' || currentUi.productMode !== 'contacts') return
              arkmeContactsTab.clear(); arkmeUi.selectSource(source)
            })
            .catch(() => undefined)
        }}
        onOpenBot={botRef => {
          arkmeContactsTab.activateAccount(contactsAccountKey)
          handoffControllerRef.current?.abort()
          const controller = new AbortController()
          handoffControllerRef.current = controller
          const generation = arkmeContactsTab.getSnapshot().generation
          const accountKey = contactsAccountKey
          void callArkme<ArkmeSourceItem>('directory.bot.open-chat', { botRef }, controller.signal)
            .then(source => {
              const current = arkmeContactsTab.getSnapshot()
              const currentUi = arkmeUi.getSnapshot()
              const context = contactsContextRef.current
              if (controller.signal.aborted || current.generation !== generation || current.accountKey !== accountKey
                || context.accountKey !== accountKey || !context.contactsMode
                || currentUi.mode !== 'source' || currentUi.productMode !== 'contacts') return
              arkmeContactsTab.clear(); arkmeUi.selectSource(source)
            })
            .catch(() => undefined)
        }}
      /> : <ArkmeNavigation
        wide
        avatarOnly={avatarOnly}
        embeddedProductShell
        showHarnessEntry
        currentSessionId={sessionState.current}
        renderSlot={renderSlot}
        searchDshMessages={searchDsh}
        onOpenDshSession={sessionId => { openDshSession(sessionId); arkmeUi.showHarness() }}
        {...(sendToSelfSource === undefined ? {} : { sendToSelfSource })}
      />}
    </div>}
    {!collapsed && directoryVisible && !contactsMode && <div
      data-arkme-owned="persistent-sidebar-resize-handle"
      role="separator"
      aria-label="调整对话列表宽度"
      aria-orientation="vertical"
      aria-valuemin={ARKME_PERSISTENT_SIDEBAR_MIN_WIDTH}
      aria-valuemax={ARKME_PERSISTENT_SIDEBAR_MAX_WIDTH}
      aria-valuenow={renderedSidebarWidth}
      style={styles.sidebarResizeHandle}
      onPointerDown={beginSidebarResize}
      onPointerMove={continueSidebarResize}
      onPointerUp={event => { stopSidebarResize(event.currentTarget, event.pointerId) }}
      onPointerCancel={event => { stopSidebarResize(event.currentTarget, event.pointerId) }}
      onLostPointerCapture={() => { stopSidebarResize() }}
    />}
  </aside>
}

export type ArkmePersistentWorkspaceProps = PropsRuntime<'conversation'>
  & PropsLocale<typeof ARKME_LOGIN_LOCALE_NAMESPACE>
  & { closeDetails(): void }

/** Arkme keeps the conversation seat and embeds the complete native DSH client inside it. */
export function ArkmePersistentWorkspace({
  sessionId, closeDetails, t,
}: ArkmePersistentWorkspaceProps) {
  const ui = useSyncExternalStore(arkmeUi.subscribe, arkmeUi.getSnapshot, arkmeUi.getSnapshot)
  const authState = useSyncExternalStore(arkmeAuthStore.subscribe, arkmeAuthStore.getSnapshot, arkmeAuthStore.getSnapshot)
  const contacts = useSyncExternalStore(arkmeContactsTab.subscribe, arkmeContactsTab.getSnapshot, arkmeContactsTab.getSnapshot)
  const authenticatedUserId = authState.auth?.status === 'authenticated' ? authState.auth.userId : undefined
  const contactsAccountKey = authState.auth?.status === 'authenticated' ? `${authState.auth.environment}:${String(authState.auth.userId)}` : undefined
  const scopedContacts = arkmeContactsTab.getSnapshotForAccount(contactsAccountKey)
  const contactsMode = ui.mode === 'source' && ui.productMode === 'contacts'
  const contactsContextRef = useRef({ accountKey: contactsAccountKey, contactsMode })
  contactsContextRef.current = { accountKey: contactsAccountKey, contactsMode }
  useLayoutEffect(() => { closeDetails() }, [closeDetails])
  useLayoutEffect(() => {
    arkmeContactsTab.activateAccount(contactsAccountKey)
    if (!contactsMode) arkmeContactsTab.clear()
  }, [contactsAccountKey, contactsMode])

  return <main data-arkme-owned="persistent-workspace" data-arkme-workspace {...(contactsMode ? { 'data-arkme-contacts-mobile-view': scopedContacts.selection.kind !== 'none' ? 'content' : 'directory' } : {})} style={styles.workspace} aria-label="Arkme 主界面">
    <ArkmePersistentClientRuntime />
    <DeepSeekHarnessSurface visible={ui.mode === 'harness'} />
    {contactsMode ? <div className="arkme-directory-detail-pane" data-arkme-contacts-workspace>
      {scopedContacts.selection.kind !== 'none' && <button type="button" className="arkme-directory-mobile-back" onClick={() => { arkmeContactsTab.clear() }}>返回联系人目录</button>}
      <DirectoryDetailPane
        accountKey={contactsAccountKey ?? ''} selection={scopedContacts.selection}
        onSelectionChange={selection => { arkmeContactsTab.activateAccount(contactsAccountKey); arkmeContactsTab.select(selection) }}
        onSourceActivated={source => {
          const current = arkmeContactsTab.getSnapshot()
          const currentUi = arkmeUi.getSnapshot()
          const context = contactsContextRef.current
          if (current.accountKey !== contactsAccountKey || context.accountKey !== contactsAccountKey || !context.contactsMode
            || currentUi.mode !== 'source' || currentUi.productMode !== 'contacts') return
          arkmeContactsTab.clear(); arkmeUi.selectSource(source)
        }}
        renderUnmarkedSpeakerDetail={candidateRef => <UnmarkedSpeakerDetail
          accountKey={contactsAccountKey ?? ''} candidateRef={candidateRef}
          onCandidateCleared={() => { arkmeContactsTab.clear() }} onDirectoryRefresh={() => { arkmeContactsTab.activateAccount(contactsAccountKey); arkmeContactsTab.refresh() }}
        />}
      />
    </div> : <div
        data-arkme-owned="arkme-conversation-layer"
        style={{
          ...styles.conversationLayer,
          visibility: ui.mode === 'harness' ? 'hidden' : 'visible',
          pointerEvents: ui.mode === 'harness' ? 'none' : 'auto',
          zIndex: ui.mode === 'harness' ? 0 : 1,
        }}
        aria-hidden={ui.mode === 'harness' ? true : undefined}
      >
        <ArkmeSurface
          t={t}
          productChrome={false}
          productNavigation={false}
          ownsWechatLogin={!startupAuthGateEnabled()}
          currentSessionId={sessionId}
          onActivateSurface={() => undefined}
        />
      </div>}
  </main>
}

export type ArkmePersistentDetailsProps = PropsRuntime<'details'> & { closeDetails(): void }

/** Claim the details seat as an empty Arkme surface so the official DSH panel is never visible. */
export function ArkmePersistentDetails({ closeDetails }: ArkmePersistentDetailsProps) {
  useLayoutEffect(() => { closeDetails() }, [closeDetails])
  return <aside data-arkme-owned="persistent-details" style={styles.details} aria-hidden />
}
