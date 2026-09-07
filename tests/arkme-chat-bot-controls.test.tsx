import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
const mocks = vi.hoisted(() => ({ callArkme: vi.fn() }))
vi.mock('../src/client/api.js', () => ({ callArkme: mocks.callArkme }))
vi.mock('../src/client/ArkmeBotSettingsPanel.js', () => ({
  ArkmeBotSettingsPanel: (props: unknown) => <div data-settings={props} />,
}))
import { ArkmeChatBotControls } from '../src/client/ArkmeChatBotControls.js'
const bot = { botRef: 'bot-ref', name: 'Test', provider: 'openclaw', description: '', status: 'offline',
  conversationProjection: 'chat', chatSourceKey: 'chat-key', directChatAvailable: true } as const
const source = { sourceRef: 'source-ref', sourceKey: 'chat-key', kind: 'private_chat', displayName: 'Test',
  isBotChat: true, activeAtMillis: 0, unreadCount: 0 } as const
let renderer: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => { renderer?.unmount() }); renderer = undefined; mocks.callArkme.mockReset() })
async function open() {
  await act(async () => { renderer = create(<ArkmeChatBotControls source={source} onUpdated={vi.fn()} onDeleted={vi.fn()} />) })
  expect(mocks.callArkme).not.toHaveBeenCalled()
  await act(async () => { renderer!.root.findByProps({ 'aria-label': 'Bot 设置' }).props.onClick() })
}
describe('Chat Bot header controls', () => {
  it('does not start duplicate lookups while a request is pending', async () => {
    mocks.callArkme.mockReturnValue(new Promise(() => {}))
    await open()
    await act(async () => { renderer!.root.findByProps({ 'aria-label': 'Bot 设置' }).props.onClick() })
    expect(mocks.callArkme).toHaveBeenCalledTimes(1)
    expect(renderer!.root.findByProps({ 'aria-label': 'Bot 设置' }).props.disabled).toBe(true)
  })
  it('does not choose a Bot when canonical identity is ambiguous', async () => {
    mocks.callArkme.mockResolvedValue({ items: [bot, { ...bot, botRef: 'another-bot' }] })
    await open()
    expect(renderer!.root.findAll(node => node.props['data-settings'] !== undefined)).toHaveLength(0)
  })
  it('resolves management only on demand using the exact canonical Chat identity', async () => {
    mocks.callArkme.mockResolvedValue({ items: [{ ...bot, chatSourceKey: 'other' }, bot] })
    await open()
    const panel = renderer!.root.findAll(node => node.props['data-settings'] !== undefined)[0]!
    expect(panel.props['data-settings'].bot).toEqual(bot)
    expect(mocks.callArkme).toHaveBeenCalledTimes(1)
  })
  it('keeps missing ownership unavailable instead of choosing another Bot', async () => {
    mocks.callArkme.mockResolvedValue({ items: [{ ...bot, chatSourceKey: 'other' }] })
    await open()
    expect(JSON.stringify(renderer!.toJSON())).toContain('当前账号没有此 Bot 的管理权限')
    expect(renderer!.root.findAll(node => node.props['data-settings'] !== undefined)).toHaveLength(0)
  })
  it('offers retry without blocking the conversation after a failed read', async () => {
    mocks.callArkme.mockRejectedValueOnce(new Error('网络异常')).mockResolvedValueOnce({ items: [bot] })
    await open()
    expect(JSON.stringify(renderer!.toJSON())).toContain('网络异常')
    await act(async () => { renderer!.root.findByProps({ 'aria-label': 'Bot 设置' }).props.onClick() })
    expect(renderer!.root.findAll(node => node.props['data-settings'] !== undefined)).toHaveLength(1)
  })
  it('does not open a settings panel when a cancelled lookup completes', async () => {
    let resolve!: (value: unknown) => void
    mocks.callArkme.mockReturnValue(new Promise(r => { resolve = r }))
    await open()
    await act(async () => { renderer!.unmount(); renderer = undefined })
    await act(async () => { resolve({ items: [bot] }) })
    expect(mocks.callArkme.mock.calls[0]![2].aborted).toBe(true)
  })
  it('uses Bot controls instead of human call and private action controls', () => {
    const sidebar = readFileSync(new URL('../src/client/ArkmeSidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toContain('source?.isBotChat === true && <ArkmeChatBotControls')
    expect(sidebar).toContain("source?.kind === 'private_chat' && source.isBotChat !== true && <ArkmePrivateCallMenu")
    expect(sidebar).toContain('source?.isBotChat !== true && shouldShowPrivateChatActions')
  })
})
