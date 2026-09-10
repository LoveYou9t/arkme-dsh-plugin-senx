import { afterEach, expect, it, vi } from 'vitest'
import { arkmeSourceNavigation as navigation } from '../src/client/source-navigation.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeUi } from '../src/client/ui-controller.js'
const topic = { sourceRef: 'signed-topic', kind: 'topic' as const, displayName: '主题', activeAtMillis: 0, unreadCount: 0 }
afterEach(() => { arkmeAuthStore.setAuth({ status: 'logged-out', environment: 'test' }); arkmeUi.showLogin() })
it('opens into the existing content owner and exposes a cached readonly projection', () => {
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7 })
  expect(navigation.openSource(topic, 'test:7')).toBe(true)
  expect(arkmeUi.getSnapshot().selectedSource).toMatchObject(topic)
  expect(navigation.getSnapshot()).toBe(navigation.getSnapshot())
  expect(Object.isFrozen(navigation.getSnapshot().selectedSource)).toBe(true)
})
it('rejects stale account, environment, and non-personal targets without changing content', () => {
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7 })
  arkmeUi.selectSource(topic)
  const before = arkmeUi.getSnapshot()
  expect(navigation.openSource({ ...topic, sourceRef: 'other' }, 'test:8')).toBe(false)
  expect(navigation.openSource(topic, 'prod:7')).toBe(false)
  expect(navigation.openSource({ ...topic, kind: 'group_chat' }, 'test:7')).toBe(false)
  expect(arkmeUi.getSnapshot()).toBe(before)
})
it('subscribes to native selections and authentication, with idempotent release', () => {
  const listener = vi.fn(); const stop = navigation.subscribe(listener)
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7 })
  arkmeUi.selectSource(topic)
  expect(listener).toHaveBeenCalled()
  stop(); stop(); listener.mockClear()
  arkmeUi.showLogin()
  expect(listener).not.toHaveBeenCalled()
})
it('does not expose a selected source after logout', () => {
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7 })
  navigation.openSource(topic, 'test:7')
  arkmeAuthStore.setAuth({ status: 'logged-out', environment: 'test' })
  expect(navigation.getSnapshot()).toMatchObject({ accountKey: undefined, selectedSource: undefined })
  expect(navigation.openSource(topic, 'test:7')).toBe(false)
})
it('does not project the previous account selection during account replacement', () => {
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 7 })
  navigation.openSource(topic, 'test:7'); navigation.getSnapshot()
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 8 })
  expect(navigation.getSnapshot().selectedSource).toBeUndefined()
  expect(navigation.getSnapshot().selectedSource).toBeUndefined()
  expect(navigation.openSource({ ...topic, sourceRef: 'new-account' }, 'test:8')).toBe(true)
  expect(navigation.getSnapshot().selectedSource?.sourceRef).toBe('new-account')
})
