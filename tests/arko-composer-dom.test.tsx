// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArkmeArkoSurface } from '../src/client/ArkmeArkoSurface.js'
import { callArkme } from '../src/client/api.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeArkoProfileStore } from '../src/client/arko-profile-store.js'
import { arkmeArkoComposerDraftKey, arkmeComposerDraftStore } from '../src/client/composer-draft-store.js'
import type { ArkmeArkoModelCatalog, ArkmeArkoHistoryItem } from '../src/types.js'

vi.mock('../src/client/api.js', async original => ({
  ...await original<typeof import('../src/client/api.js')>(), callArkme: vi.fn(),
}))

const draftKey = arkmeArkoComposerDraftKey(10001)
const catalog: ArkmeArkoModelCatalog = {
  effectiveRouteKey: 'route-a', defaultRouteKey: 'route-a', selectionSource: 'personal',
  options: [
    { routeKey: 'route-a', displayName: '模型 A', description: '当前模型说明', provider: 'provider-x', selected: true, recommended: false },
    { routeKey: 'route-b', displayName: '模型 B', description: '推荐模型说明', provider: 'provider-y', selected: false, recommended: true },
  ],
}
let root: Root
let host: HTMLDivElement
let history: ArkmeArkoHistoryItem[]
let models: ArkmeArkoModelCatalog
let activate: ReturnType<typeof vi.fn>
let ask: ReturnType<typeof vi.fn>
function trigger(): HTMLButtonElement { return host.querySelector('[title="选择模型"]')! }
function menu(): HTMLElement | null { return document.querySelector('[role="menu"]') }
function option(name: string): HTMLButtonElement {
  return [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
}
async function click(node: HTMLElement) { expect(node).not.toBeNull(); await act(async () => node.click()) }
async function mount() { await act(async () => root.render(<ArkmeArkoSurface />)) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  Range.prototype.getBoundingClientRect = () => new DOMRect(20, 100, 1, 24)
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList
  sessionStorage.clear()
  arkmeComposerDraftStore.clearAccount(10001)
  arkmeArkoProfileStore.activateUser(undefined)
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 10001 })
  history = []
  models = structuredClone(catalog)
  activate = vi.fn().mockImplementation(async ({ routeKey }) => ({ ...models, effectiveRouteKey: routeKey,
    options: models.options.map(item => ({ ...item, selected: item.routeKey === routeKey })) }))
  ask = vi.fn().mockResolvedValue({ sessionId: 88, userMsgId: 1, assistantMsgId: 2, status: 'completed', text: '收到', reasoning: '', createdRecordUids: [] })
  vi.mocked(callArkme).mockImplementation(async (method, input) => {
    if (method === 'arko.models') return models as never
    if (method === 'arko.model.activate') return activate(input)
    if (method === 'arko.ask') return ask(input)
    if (method === 'arko.session') return { sessionId: 88 } as never
    if (method === 'arko.profile') return { displayName: 'Arko', version: 1 } as never
    if (method === 'arko.history') return { items: history } as never
    if (method === 'user.profile') return { profile: {} } as never
    if (method === 'emoji.recent.list') return [] as never
    throw new Error(`unexpected method: ${method}`)
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  arkmeComposerDraftStore.clearAccount(10001)
  arkmeArkoProfileStore.activateUser(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Arko composer with public DSH controls', () => {
  it('places its model menu beside send and preserves model descriptions and recommendations', async () => {
    await mount()
    expect(host.querySelector('footer')!.contains(trigger())).toBe(true)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    await click(trigger())
    expect(menu()).not.toBeNull()
    expect(host.querySelector('[aria-modal="true"]')).toBeNull()
    expect(menu()!.textContent).toContain('推荐模型说明')
    expect(menu()!.textContent).toContain('推荐')
    expect(option('模型 A').disabled).toBe(true)
  })

  it('uses only the Arko route key and applies the confirmed selection to the next send', async () => {
    await mount()
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '已有草稿'))
    await click(trigger())
    await click(option('模型 B'))
    expect(activate).toHaveBeenCalledExactlyOnceWith({ routeKey: 'route-b' })
    expect(menu()).toBeNull()
    expect(trigger().textContent).toContain('模型 B')
    expect(arkmeComposerDraftStore.get(draftKey).text).toBe('已有草稿')
    await click(host.querySelector('[aria-label="Arko 能干什么"]')!)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: '你能帮我干什么', modelRouteKey: 'route-b' }))
    expect(arkmeComposerDraftStore.get(draftKey).text).toBe('已有草稿')
    await click(host.querySelector('[title="发送"]')!)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ text: '已有草稿', modelRouteKey: 'route-b' }))
  })

  it('deduplicates rapid selection and locks both send paths until the server confirms', async () => {
    let finish!: (value: ArkmeArkoModelCatalog) => void
    activate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await mount()
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '保留草稿'))
    await click(trigger())
    const target = option('模型 B')
    await act(async () => {
      target.click()
      target.click()
      host.querySelector('[contenteditable="true"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(ask).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledTimes(1)
    expect((host.querySelector('[title="发送"]') as HTMLButtonElement).disabled).toBe(true)
    expect((host.querySelector('[aria-label="Arko 能干什么"]') as HTMLButtonElement).disabled).toBe(true)
    expect((host.querySelector('[title="清除上下文"]') as HTMLButtonElement).disabled).toBe(true)
    expect(trigger().textContent).toContain('模型 A')
    await act(async () => finish({ ...models, effectiveRouteKey: 'route-b' }))
    expect(trigger().textContent).toContain('模型 B')
    expect(arkmeComposerDraftStore.get(draftKey).text).toBe('保留草稿')
  })

  it('closes an open model menu when a keyboard send starts and keeps it closed afterwards', async () => {
    let finish!: (value: unknown) => void
    ask.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await mount()
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '发送草稿'))
    await click(trigger())
    expect(menu()).not.toBeNull()
    const editor = host.querySelector('[contenteditable="true"]')!
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
    await act(async () => finish({ sessionId: 88, userMsgId: 1, assistantMsgId: 2,
      status: 'completed', text: '收到', reasoning: '', createdRecordUids: [] }))
    expect(trigger().disabled).toBe(false)
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(activate).not.toHaveBeenCalled()
  })

  it('preserves the prior model and draft after failure and allows retry', async () => {
    activate.mockRejectedValueOnce(new Error('切换失败，请重试'))
    await mount()
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '保留草稿'))
    await click(trigger())
    await click(option('模型 B'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('切换失败，请重试')
    expect(host.querySelector('[data-arko-message-viewport]')!.contains(host.querySelector('[role="alert"]'))).toBe(false)
    expect(trigger().textContent).toContain('模型 A')
    expect(arkmeComposerDraftStore.get(draftKey).text).toBe('保留草稿')
    expect((host.querySelector('[title="发送"]') as HTMLButtonElement).disabled).toBe(false)
    expect((host.querySelector('[title="清除上下文"]') as HTMLButtonElement).disabled).toBe(false)
    expect(trigger().disabled).toBe(false)
    await click(option('模型 B'))
    expect(activate).toHaveBeenCalledTimes(2)
    expect(menu()).toBeNull()
  })

  it('keeps continuation identity after selecting a different model for future tasks', async () => {
    history = [{ messageId: 8, sessionId: 88, role: 'assistant', text: '请补充信息', reasoning: '',
      createdAtMillis: 1, status: 1, runUid: 'existing-run', runStatus: 'waiting_user', createdRecordUids: [] }]
    await mount()
    await click(trigger())
    await click(option('模型 B'))
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '补充信息'))
    await click(host.querySelector('[title="发送"]')!)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 88,
      replyToRunUid: 'existing-run', replyToAssistantMsgId: 8 }))
    expect(ask.mock.calls[0]![0]).not.toHaveProperty('modelRouteKey')
  })

  it('retains the selected route and request identity when retrying an unknown send outcome', async () => {
    ask.mockRejectedValueOnce(new Error('连接中断'))
    await mount()
    await click(trigger())
    await click(option('模型 B'))
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '发送内容'))
    await click(host.querySelector('[title="发送"]')!)
    expect(trigger().disabled).toBe(true)
    expect((host.querySelector('[title="清除上下文"]') as HTMLButtonElement).disabled).toBe(true)
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === '重试确认')!
    expect(host.querySelector('[data-arko-message-viewport]')!.contains(retry)).toBe(false)
    await click(retry)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]![0]).toEqual(ask.mock.calls[0]![0])
    expect(ask.mock.calls[1]![0].modelRouteKey).toBe('route-b')
    expect(trigger().disabled).toBe(false)
  })

  it('keeps the previous session, history and draft after a failed context clear, then recovers', async () => {
    history = [{ messageId: 8, sessionId: 88, role: 'assistant', text: '已有历史', reasoning: '',
      createdAtMillis: 1, status: 1, createdRecordUids: [] }]
    const original = vi.mocked(callArkme).getMockImplementation()!
    const clear = vi.fn().mockRejectedValueOnce(new Error('清除失败')).mockResolvedValue({ sessionId: 99 })
    vi.mocked(callArkme).mockImplementation((method, input, signal) => method === 'arko.new-session'
      ? clear() : original(method, input, signal))
    await mount()
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '已有草稿'))
    async function confirmClear() {
      await click(host.querySelector('[title="清除上下文"]')!)
      await click([...host.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '确认') as HTMLButtonElement)
    }
    await confirmClear()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('清除失败')
    expect(host.textContent).toContain('已有历史')
    expect(arkmeComposerDraftStore.get(draftKey).text).toBe('已有草稿')
    await click(host.querySelector('[aria-label="Arko 能干什么"]')!)
    expect(ask.mock.calls[0]![0].sessionId).toBe(88)
    await confirmClear()
    await click(host.querySelector('[title="发送"]')!)
    expect(ask.mock.calls[1]![0]).toEqual(expect.objectContaining({ sessionId: 99, text: '已有草稿' }))
    expect(host.textContent).toContain('已有历史')
  })

  it('keeps ordinary sending available when the optional model catalog fails to load', async () => {
    const original = vi.mocked(callArkme).getMockImplementation()!
    vi.mocked(callArkme).mockImplementation((method, input, signal) => method === 'arko.models'
      ? Promise.reject(new Error('模型目录不可用')) : original(method, input, signal))
    await mount()
    expect(trigger().disabled).toBe(true)
    await act(async () => arkmeComposerDraftStore.setText(draftKey, '继续发送'))
    await click(host.querySelector('[title="发送"]')!)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).not.toHaveProperty('modelRouteKey')
  })

  it('closes only the foreground model menu on Escape while keeping message detail open', async () => {
    history = [{ messageId: 8, sessionId: 88, role: 'assistant', text: '完整回答', reasoning: '',
      createdAtMillis: 1, status: 1, createdRecordUids: [] }]
    await mount()
    await click([...host.querySelectorAll('p')].find(node => node.textContent === '完整回答')!.parentElement!)
    const detail = host.querySelector('[aria-label="消息详情"]')
    expect(detail).not.toBeNull()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(menu()).toBeNull()
    expect(host.querySelector('[aria-label="消息详情"]')).toBe(detail)
    expect(activate).not.toHaveBeenCalled()
  })

  it('dismisses through Escape and outside pointer without changing the selection', async () => {
    await mount()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menu()).toBeNull()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(menu()).toBeNull()
    expect(activate).not.toHaveBeenCalled()
  })

  it.each([0, 1])('keeps a %s-option catalog non-interactive', async count => {
    models.options = models.options.slice(0, count)
    await mount()
    expect(trigger().disabled).toBe(true)
    expect(trigger().textContent).toContain(count === 0 ? '模型目录暂不可用' : '模型 A')
    expect(activate).not.toHaveBeenCalled()
  })

  it('removes a portaled menu when the surface unmounts', async () => {
    await mount()
    await click(trigger())
    expect(menu()).not.toBeNull()
    await act(async () => root.render(null))
    expect(menu()).toBeNull()
  })
})
