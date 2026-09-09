// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArkmeMessageContent } from '../src/client/ArkmeRichContent.js'
import { expandTextUpwards } from '../src/client/expand-text-upwards.js'
import { arkmeShouldToggleMessageSelectFromRowClick } from '../src/client/ArkmeSidebar.js'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === host ? 400 : 2000 })
  host = document.createElement('div'); host.style.overflowY = 'auto'
  host.scrollTo = vi.fn((options: ScrollToOptions) => { host.scrollTop = options.top ?? host.scrollTop })
  document.body.append(host); root = createRoot(host)
})

it('does not compensate again when browser anchoring already preserved the button', () => {
  const button = document.createElement('button'); host.append(button)
  host.scrollTop = 200
  let growth = 0
  vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 300 + growth - host.scrollTop, 40, 20))
  expandTextUpwards(button, () => { growth = 400; host.scrollTop += 400 })
  expect(host.scrollTop).toBe(600)
})

it('still expands without a scroll container', () => {
  host.style.overflowY = 'visible'
  const button = document.createElement('button'); host.append(button)
  const expand = vi.fn()
  expandTextUpwards(button, expand)
  expect(expand).toHaveBeenCalledOnce()
  expect(host.scrollTo).not.toHaveBeenCalled()
})

it('finds the scroll container when expansion creates its first overflow', () => {
  const button = document.createElement('button'); host.append(button)
  let height = 300
  Object.defineProperty(host, 'scrollHeight', { get: () => height })
  vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, height - host.scrollTop, 40, 20))
  expandTextUpwards(button, () => { height = 900 })
  expect(host.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'instant' })
})

it('preserves the existing message selection capture before the expansion handler', () => {
  const selected = vi.fn()
  const item = Object.freeze({ itemUid: 'select', senderName: '我', isMe: true, sendAtMillis: 1, status: 1, title: '', textContent: '长'.repeat(301) })
  act(() => root.render(<div onClickCapture={event => {
    if (!arkmeShouldToggleMessageSelectFromRowClick(event.target)) return
    event.preventDefault(); event.stopPropagation(); selected()
  }}><ArkmeMessageContent item={item} /></div>))
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  act(() => button.click())
  expect(selected).toHaveBeenCalledOnce()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(host.scrollTo).not.toHaveBeenCalled()
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([
  { textFormat: 'plain', nested: false }, { textFormat: 'markdown', nested: false },
  { textFormat: 'plain', nested: true }, { textFormat: 'markdown', nested: true },
] as const)('expands $textFormat upwards with nested=$nested, preserving existing collapse rules', ({ textFormat, nested }) => {
  act(() => root.render(<div style={nested ? { overflowY: 'auto' } : undefined}><ArkmeMessageContent item={{ itemUid: 'long', senderName: '我', isMe: true, sendAtMillis: 1, status: 1, title: '', textContent: '长'.repeat(301), textFormat }} /></div>))
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(button.getAttribute('aria-expanded')).toBe('false')
  host.scrollTop = 200
  vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0,
    300 + (button.getAttribute('aria-expanded') === 'true' ? 400 : 0) - host.scrollTop, 40, 20))
  const previousBottom = button.getBoundingClientRect().bottom
  act(() => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(button.getBoundingClientRect().bottom).toBe(previousBottom)
  expect(host.scrollTop).toBe(600)
  expect(host.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'instant' })
  act(() => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('false')
  // This fix is limited to expansion; retain the existing collapse behavior.
  expect(host.scrollTop).toBe(600)
})
