import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise'
import { Check } from '@phosphor-icons/react/dist/icons/Check'
import { Copy } from '@phosphor-icons/react/dist/icons/Copy'
import { DesktopTower } from '@phosphor-icons/react/dist/icons/DesktopTower'
import { DeviceMobile } from '@phosphor-icons/react/dist/icons/DeviceMobile'
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple'
import { Plus } from '@phosphor-icons/react/dist/icons/Plus'
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck'
import { X } from '@phosphor-icons/react/dist/icons/X'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import type { DshRemoteBindingProjection, DshRemotePairingTicket, DshRemoteStatus } from '../dsh-remote/types.js'
import { callArkme } from './api.js'

const DSH_REMOTE_QR_DISPLAY_SIZE = 320

export function buildDshRemotePairingQr(payload: string): {
  dataUrl: string
  moduleCount: number
  displaySize: number
} {
  const code = qrcode(0, 'L')
  code.addData(payload)
  code.make()
  return {
    dataUrl: code.createDataURL(5, 4),
    moduleCount: code.getModuleCount(),
    displaySize: DSH_REMOTE_QR_DISPLAY_SIZE,
  }
}

function platformLabel(platform: string): string {
  const normalized = platform.trim().toLowerCase()
  if (normalized === 'android') return 'Android'
  if (normalized === 'ios') return 'iPhone'
  return platform.trim() || '移动设备'
}

export function formatDshRemoteDeviceActivity(binding: DshRemoteBindingProjection, now = Date.now()): string {
  const timestamp = binding.lastUsedAtMillis ?? binding.boundAtMillis
  const suffix = binding.lastUsedAtMillis === undefined ? '绑定' : '连接'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return binding.lastUsedAtMillis === undefined ? '刚刚绑定' : '刚刚连接'
  if (elapsed < 60 * 60_000) return `${String(Math.floor(elapsed / 60_000))} 分钟前${suffix}`
  if (elapsed < 24 * 60 * 60_000) return `${String(Math.floor(elapsed / (60 * 60_000)))} 小时前${suffix}`
  if (elapsed < 7 * 24 * 60 * 60_000) return `${String(Math.floor(elapsed / (24 * 60 * 60_000)))} 天前${suffix}`
  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日${suffix}`
}

function remoteStatusDescription(status: DshRemoteStatus | undefined): string {
  if (status === undefined) return '正在读取连接状态…'
  if (!status.available) return status.unavailableReason ?? '远控服务暂不可用'
  if (!status.enabled) return '当前已关闭；开启后，已绑定设备可继续 DSH 会话'
  if (!status.connected) return '正在连接远控服务…'
  return '已连接远控服务'
}

export type DshRemotePairingMode = 'qr' | 'code'

interface DshRemotePairingDialogProps {
  pairing: DshRemotePairingTicket
  now: number
  mode: DshRemotePairingMode
  copied: boolean
  busy: boolean
  onModeChange(mode: DshRemotePairingMode): void
  onCopy(): void
  onRegenerate(): void
  onClose(): void
}

export function DshRemotePairingDialog({
  pairing,
  now,
  mode,
  copied,
  busy,
  onModeChange,
  onCopy,
  onRegenerate,
  onClose,
}: DshRemotePairingDialogProps) {
  const qr = useMemo(() => buildDshRemotePairingQr(pairing.qrPayload), [pairing.qrPayload])
  const seconds = Math.max(0, Math.ceil((pairing.expiresAtMillis - now) / 1000))
  const expired = seconds === 0

  return <div className="arkme-remote-dialog-backdrop">
    <section className="arkme-remote-dialog" role="dialog" aria-modal="true" aria-labelledby="arkme-remote-dialog-title">
      <button type="button" className="arkme-remote-dialog-close" aria-label="取消本次配对" disabled={busy} onClick={onClose}><X size={17} aria-hidden /></button>
      <div className="arkme-remote-dialog-symbol" aria-hidden>
        <DeviceMobile size={24} weight="duotone" /><span /><DesktopTower size={24} weight="duotone" />
      </div>
      <header><h2 id="arkme-remote-dialog-title">在手机上连接这台电脑</h2><p>打开 Arkme 移动端，在 DSH 远控设置中完成配对</p></header>
      <div className="arkme-remote-pairing-tabs" role="tablist" aria-label="选择配对方式">
        <button type="button" role="tab" aria-selected={mode === 'qr'} onClick={() => { onModeChange('qr') }}>二维码</button>
        <button type="button" role="tab" aria-selected={mode === 'code'} onClick={() => { onModeChange('code') }}>配对码</button>
      </div>
      <div className={`arkme-remote-pairing-display is-${mode}${expired ? ' is-expired' : ''}`}>
        {expired ? <div className="arkme-remote-pairing-expired"><strong>配对码已失效</strong><p>重新生成后即可继续连接。</p><button type="button" disabled={busy} onClick={onRegenerate}>重新生成</button></div>
          : mode === 'qr' ? <><img src={qr.dataUrl} width={qr.displaySize} height={qr.displaySize} alt="远控配对二维码" /><p>使用手机扫描二维码</p></>
            : <><strong className="arkme-remote-pairing-code">{pairing.pairingCode}</strong><p>在手机端输入这组 8 位配对码</p></>}
        {!expired && <div className="arkme-remote-pairing-tools">
          {mode === 'code' && <button type="button" aria-label={copied ? '配对码已复制' : `复制配对码 ${pairing.pairingCode}`} disabled={busy} onClick={onCopy}>{copied ? <Check size={16} weight="bold" aria-hidden /> : <Copy size={16} aria-hidden />}</button>}
          <button type="button" aria-label="生成新配对码" disabled={busy} onClick={onRegenerate}><ArrowClockwise size={16} aria-hidden /></button>
        </div>}
      </div>
      <div className="arkme-remote-dialog-note"><ShieldCheck size={15} aria-hidden /><span>{expired ? '本次配对已失效，重新生成后即可继续。' : `本次配对将在 ${String(seconds)} 秒后失效；绑定成功后无需再次配对。`}</span></div>
    </section>
  </div>
}

export function ArkmeRemoteSettingsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DshRemoteStatus>()
  const [pairing, setPairing] = useState<DshRemotePairingTicket>()
  const [bindings, setBindings] = useState<DshRemoteBindingProjection[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [pairingMode, setPairingMode] = useState<DshRemotePairingMode>('qr')
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [desktopName, setDesktopName] = useState('')

  const refresh = async (signal?: AbortSignal, forceBindingRefresh = false) => {
    const next = await callArkme<DshRemoteStatus>('remote.getStatus', undefined, signal)
    setStatus(next)
    setPairing(next.pairingAttempt)
    setBindings(next.bindings)
    if (next.available && forceBindingRefresh) {
      setBindings(await callArkme<DshRemoteBindingProjection[]>('remote.listBindings', undefined, signal))
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal, true).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught))
    })
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    const poll = setInterval(() => {
      void refresh(controller.signal).catch(caught => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught))
      })
    }, 2_000)
    return () => { controller.abort(); clearInterval(timer); clearInterval(poll) }
  }, [])

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }
  const toggle = () => { void run(async () => {
    const next = await callArkme<DshRemoteStatus>('remote.setEnabled', { enabled: status?.enabled !== true })
    setStatus(next)
    if (!next.enabled) setPairing(undefined)
  }) }
  const createPairing = () => { void run(async () => {
    setPairing(await callArkme<DshRemotePairingTicket>('remote.createPairingAttempt'))
    setPairingMode('qr')
    setCopied(false)
  }) }
  const cancelPairing = () => { if (pairing !== undefined) void run(async () => {
    await callArkme('remote.cancelPairingAttempt', { pairingRef: pairing.pairingRef })
    setPairing(undefined)
    setCopied(false)
  }) }
  const rename = () => {
    const displayName = desktopName.trim()
    if (displayName === '') return
    void run(async () => {
      setStatus(await callArkme<DshRemoteStatus>('remote.renameDesktop', { displayName }))
      setRenaming(false)
      setDesktopName('')
    })
  }
  const revoke = (binding: DshRemoteBindingProjection) => {
    if (!window.confirm(`撤销“${binding.controllerDisplayName}”的远控权限？`)) return
    void run(async () => {
      await callArkme('remote.revokeBinding', { bindingRef: binding.bindingRef })
      setBindings(await callArkme<DshRemoteBindingProjection[]>('remote.listBindings'))
    })
  }
  const copyPairingCode = () => { if (pairing !== undefined) void run(async () => {
    if (navigator.clipboard?.writeText === undefined) throw new Error('当前环境不支持复制，请手动输入配对码')
    await navigator.clipboard.writeText(pairing.pairingCode)
    setCopied(true)
  }) }

  const visibleBindings = bindings.filter(binding => binding.status !== 'revoked')
  const canPair = !busy && status?.connected === true

  return <div className="arkme-remote-settings-dialog-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy && pairing === undefined) onClose()
  }}>
    <section className="arkme-remote-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="arkme-remote-settings-title" data-arkme-remote-settings>
      <header className="arkme-remote-page-header">
        <div><h1 id="arkme-remote-settings-title">移动端远控</h1><p>管理手机对这台电脑中 DSH 会话的访问</p></div>
        <button type="button" autoFocus className="arkme-remote-settings-close" aria-label="关闭移动端远控设置" disabled={busy} onClick={onClose}><X size={17} aria-hidden /></button>
      </header>

      <div className="arkme-remote-settings-dialog-body">
        <section className="arkme-remote-section" aria-labelledby="arkme-remote-devices-title">
          <header className="arkme-remote-section-header">
            <div><h2 id="arkme-remote-devices-title">可控制这台电脑的设备</h2><p>已绑定设备可继续这台电脑中的 DSH 会话</p></div>
            <div><button type="button" className="arkme-remote-icon-button" aria-label="刷新设备列表" disabled={busy} onClick={() => { void run(async () => { await refresh(undefined, true) }) }}><ArrowClockwise size={16} aria-hidden /></button>
              <button type="button" className="arkme-remote-add-button" disabled={!canPair} onClick={createPairing}><Plus size={14} aria-hidden />添加</button></div>
          </header>
          <div className="arkme-remote-settings-card">
            <div className="arkme-remote-allow-row"><div><strong>允许连接</strong><span>{remoteStatusDescription(status)}</span></div><button type="button" className="arkme-remote-switch" role="switch" aria-label="允许移动端远程控制" aria-checked={status?.enabled === true} disabled={busy || status?.available !== true} onClick={toggle}><span aria-hidden /></button></div>
            {visibleBindings.map(binding => <div key={binding.bindingRef} className="arkme-remote-device-row">
              <DeviceMobile size={20} weight="duotone" aria-hidden /><div><strong>{binding.controllerDisplayName}</strong><span>{platformLabel(binding.controllerPlatform)} · {formatDshRemoteDeviceActivity(binding, now)}</span></div>
              <button type="button" disabled={busy} onClick={() => { revoke(binding) }}>撤销访问权限</button>
            </div>)}
            {visibleBindings.length === 0 && <div className="arkme-remote-empty-row"><DeviceMobile size={18} aria-hidden /><span>尚未添加设备</span></div>}
          </div>
        </section>

        <section className="arkme-remote-section" aria-labelledby="arkme-remote-other-title">
          <header className="arkme-remote-section-header"><div><h2 id="arkme-remote-other-title">其他设置</h2></div></header>
          <div className="arkme-remote-settings-card">
            <button type="button" className="arkme-remote-name-row" disabled={busy} onClick={() => { setRenaming(value => !value) }}><DesktopTower size={20} weight="duotone" aria-hidden /><span><strong>电脑名称</strong><small>修改在移动端显示的名称</small></span><PencilSimple size={15} aria-hidden /></button>
            {renaming && <form className="arkme-remote-rename" onSubmit={event => { event.preventDefault(); rename() }}><input autoFocus value={desktopName} maxLength={48} aria-label="电脑名称" placeholder="例如：办公室 Mac" disabled={busy} onChange={event => { setDesktopName(event.currentTarget.value) }} /><button type="submit" disabled={busy || desktopName.trim() === ''}>保存</button><button type="button" disabled={busy} onClick={() => { setRenaming(false); setDesktopName('') }}>取消</button></form>}
          </div>
        </section>

        {error !== '' && <div className="arkme-redesign-settings-error arkme-remote-error" role="alert">{error}</div>}
      </div>
    </section>
    {pairing !== undefined && <DshRemotePairingDialog pairing={pairing} now={now} mode={pairingMode} copied={copied} busy={busy} onModeChange={setPairingMode} onCopy={copyPairingCode} onRegenerate={createPairing} onClose={cancelPairing} />}
  </div>
}
