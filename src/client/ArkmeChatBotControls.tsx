import { useEffect, useRef, useState } from 'react'
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix'
import type { ArkmeBotSummary, ArkmeSourceItem } from '../types.js'
import { callArkme } from './api.js'
import { ArkmeBotSettingsPanel } from './ArkmeBotSettingsPanel.js'
import { botUsesStandardChatSource } from './bot-conversation-routing.js'
import { arkmeTheme } from './arkme-theme.js'

export function ArkmeChatBotControls({ source, onUpdated, onDeleted }: {
  source: ArkmeSourceItem
  onUpdated(bot: ArkmeBotSummary): void
  onDeleted(): void
}) {
  const [bot, setBot] = useState<ArkmeBotSummary>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController>()
  useEffect(() => () => { request.current?.abort() }, [])

  const open = async () => {
    if (request.current !== undefined || source.sourceKey === undefined) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setError('')
    try {
      const result = await callArkme<{ items: ArkmeBotSummary[] }>('bots.list', undefined, controller.signal)
      if (controller.signal.aborted) return
      const matches = result.items.filter(item => botUsesStandardChatSource(item) && item.chatSourceKey === source.sourceKey)
      if (matches.length !== 1) throw new Error('当前账号没有此 Bot 的管理权限')
      setBot(matches[0])
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '暂时无法加载 Bot 设置')
    } finally {
      if (!controller.signal.aborted) { request.current = undefined; setLoading(false) }
    }
  }

  return <>
    <button type="button" aria-label="Bot 设置" title="Bot 设置" disabled={loading || source.sourceKey === undefined}
      style={{ width: 36, height: 36, border: 0, background: 'transparent', color: arkmeTheme.secondary, cursor: 'pointer' }}
      onClick={() => { void open() }}><GearSix size={20} /></button>
    {loading && <span role="status">正在加载 Bot 设置…</span>}
    {error !== '' && <span role="alert" style={{ color: arkmeTheme.danger }}>{error}，请重试设置按钮</span>}
    {bot !== undefined && <ArkmeBotSettingsPanel bot={bot} onClose={() => { setBot(undefined) }}
      onUpdated={updated => { setBot(updated); onUpdated(updated) }}
      onDeleted={() => { setBot(undefined); onDeleted() }} />}
  </>
}
