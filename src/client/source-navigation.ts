import type { ArkmeSourceItem } from '../types.js'
import { arkmeAuthStore } from './auth-store.js'
import { arkmeUi } from './ui-controller.js'

export interface ArkmeSourceNavigationSnapshot {
  readonly accountKey: string | undefined
  readonly selectedSource: Readonly<ArkmeSourceItem> | undefined
  readonly recordRevision: number
}

export interface ArkmeSourceNavigation {
  getSnapshot(): ArkmeSourceNavigationSnapshot
  subscribe(listener: () => void): () => void
  /** A caller must retain the account key that accompanied its directory read. */
  openSource(source: Readonly<ArkmeSourceItem>, accountKey: string): boolean
}

let previousAuth: unknown
let previousUi: unknown
let previousSelected: unknown
let snapshot: ArkmeSourceNavigationSnapshot

export const arkmeSourceNavigation: ArkmeSourceNavigation = {
  getSnapshot() {
    const auth = arkmeAuthStore.getSnapshot().auth
    const ui = arkmeUi.getSnapshot()
    if (auth !== previousAuth || ui !== previousUi || snapshot === undefined) {
      previousAuth = auth
      previousUi = ui
      const accountKey = auth?.status === 'authenticated' ? `${auth.environment}:${String(auth.userId)}` : undefined
      const staleSelection = snapshot !== undefined && snapshot.accountKey !== accountKey && ui.selectedSource === previousSelected
      snapshot = Object.freeze({
        accountKey: auth?.status === 'authenticated' ? `${auth.environment}:${String(auth.userId)}` : undefined,
        selectedSource: !staleSelection && auth?.status === 'authenticated' && ui.mode === 'source' && ui.selectedSource !== undefined
          ? (ui.selectedSource === previousSelected && snapshot !== undefined ? snapshot.selectedSource : Object.freeze({ ...ui.selectedSource })) : undefined,
        recordRevision: ui.recordRevision,
      })
    }
    previousSelected = ui.selectedSource
    return snapshot
  },
  subscribe(listener) {
    const stopAuth = arkmeAuthStore.subscribe(listener)
    const stopUi = arkmeUi.subscribe(listener)
    return () => { stopAuth(); stopUi() }
  },
  openSource(source, accountKey) {
    const auth = arkmeAuthStore.getSnapshot().auth
    if (auth?.status !== 'authenticated' || `${auth.environment}:${String(auth.userId)}` !== accountKey) return false
    if (!['send_to_self', 'default_category', 'topic'].includes(source.kind) || !source.sourceRef?.trim()) return false
    arkmeSourceNavigation.getSnapshot()
    arkmeUi.selectSource({ ...source })
    return true
  },
}
