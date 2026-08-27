import { ArrowLeft } from '@phosphor-icons/react/dist/icons/ArrowLeft'
import { Check } from '@phosphor-icons/react/dist/icons/Check'
import { Copy } from '@phosphor-icons/react/dist/icons/Copy'
import { DesktopTower } from '@phosphor-icons/react/dist/icons/DesktopTower'
import { DeviceMobile } from '@phosphor-icons/react/dist/icons/DeviceMobile'
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple'
import { QrCode } from '@phosphor-icons/react/dist/icons/QrCode'
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck'
import { Trash } from '@phosphor-icons/react/dist/icons/Trash'
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
  const suffix = binding.lastUsedAtMillis === undefined ? '绑定' : '使用'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return binding.lastUsedAtMillis === undefined ? '刚刚绑定' : '刚刚使用'
  if (elapsed < 60 * 60_000) return `${String(Math.floor(elapsed / 60_000))} 分钟前${suffix}`
  if (elapsed < 24 * 60 * 60_000) return `${String(Math.floor(elapsed / (60 * 60_000)))} 小时前${suffix}`
  if (elapsed < 7 * 24 * 60 * 60_000) return `${String(Math.floor(elapsed / (24 * 60 * 60_000)))} 天前${suffix}`
  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日${suffix}`
}

interface RemoteStatusPresentation {
  label: string
  description: string
  tone: 'online' | 'pending' | 'offline'
}

function remoteStatusPresentation(status: DshRemoteStatus | undefined): RemoteStatusPresentation {
  if (status === undefined) return { label: '正在读取状态', description: '正在连接这台电脑', tone: 'pending' }
  if (!status.available) return {
    label: '当前不可用',
    description: status.unavailableReason ?? '远控服务暂不可用',
    tone: 'offline',
  }
  if (!status.enabled) return { label: '远程控制已关闭', description: '开启后，已绑定手机可访问这台电脑', tone: 'offline' }
  if (!status.connected) return { label: '正在连接远控服务', description: '连接恢复后即可从手机访问', tone: 'pending' }
  return { label: '这台电脑可远程访问', description: '仅已绑定手机可以控制 DSH 会话', tone: 'online' }
}

export function ArkmeRemoteSettingsPanel({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<DshRemoteStatus>()
  const [pairing, setPairing] = useState<DshRemotePairingTicket>()
  const [bindings, setBindings] = useState<DshRemoteBindingProjection[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [desktopName, setDesktopName] = useState('')
  const qr = useMemo(
    () => pairing === undefined ? undefined : buildDshRemotePairingQr(pairing.qrPayload),
    [pairing?.qrPayload],
  )

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
    const ticket = await callArkme<DshRemotePairingTicket>('remote.createPairingAttempt')
    setPairing(ticket)
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

  const seconds = pairing === undefined ? 0 : Math.max(0, Math.ceil((pairing.expiresAtMillis - now) / 1000))
  const pairingExpired = pairing !== undefined && seconds === 0
  const visibleBindings = bindings.filter(binding => binding.status !== 'revoked')
  const presentation = remoteStatusPresentation(status)
  const canPair = !busy && status?.connected === true

  return <div className="arkme-redesign-settings-surface" data-arkme-remote-settings aria-label="远程控制设置">
    <div className="arkme-redesign-settings-shell arkme-remote-settings-shell">
      <header className="arkme-remote-page-header">
        <button type="button" className="arkme-remote-back" aria-label="返回 Arkme 设置" onClick={onBack}>
          <ArrowLeft size={17} aria-hidden /><span>设置</span>
        </button>
        <div><h1>移动端远控</h1><p>在手机上继续这台电脑里的 DSH 会话</p></div>
      </header>

      <section className="arkme-remote-overview" aria-label="远控状态">
        <div className={`arkme-remote-status-icon is-${presentation.tone}`}><DesktopTower size={24} weight="duotone" aria-hidden /></div>
        <div className="arkme-remote-status-copy">
          <span className={`arkme-remote-status-label is-${presentation.tone}`}><i aria-hidden />{presentation.label}</span>
          <p>{presentation.description}</p>
        </div>
        <button
          type="button"
          className="arkme-remote-switch"
          role="switch"
          aria-label="允许移动端远程控制"
          aria-checked={status?.enabled === true}
          disabled={busy || status?.available !== true}
          onClick={toggle}
        ><span aria-hidden /></button>
        <div className="arkme-remote-overview-actions">
          <button type="button" className="arkme-remote-primary-button" disabled={!canPair} onClick={createPairing}>
            <DeviceMobile size={16} aria-hidden />{pairing === undefined ? '添加手机' : '生成新配对码'}
          </button>
          <button type="button" className="arkme-remote-secondary-button" disabled={busy} onClick={() => { setRenaming(value => !value) }}>
            <PencilSimple size={15} aria-hidden />电脑名称
          </button>
        </div>
        {renaming && <form className="arkme-remote-rename" onSubmit={event => { event.preventDefault(); rename() }}>
          <label htmlFor="arkme-remote-desktop-name">在手机上显示为</label>
          <div><input id="arkme-remote-desktop-name" autoFocus value={desktopName} maxLength={48} placeholder="例如：办公室 Mac" disabled={busy} onChange={event => { setDesktopName(event.currentTarget.value) }} />
            <button type="submit" disabled={busy || desktopName.trim() === ''}>保存</button>
            <button type="button" disabled={busy} onClick={() => { setRenaming(false); setDesktopName('') }}>取消</button>
          </div>
        </form>}
      </section>

      {pairing !== undefined && <section className="arkme-remote-pairing-card" aria-labelledby="arkme-remote-pairing-title">
        <header>
          <span className="arkme-remote-section-icon"><QrCode size={20} weight="duotone" aria-hidden /></span>
          <div><h2 id="arkme-remote-pairing-title">连接新手机</h2><p>打开 Arkme 移动端，进入「设置 → DSH 远控」完成配对</p></div>
          <span className={`arkme-remote-expiry${pairingExpired ? ' is-expired' : ''}`} aria-live="polite">
            {pairingExpired ? '已失效' : `${String(seconds)} 秒后失效`}
          </span>
        </header>
        {pairingExpired ? <div className="arkme-remote-pairing-expired">
          <p>本次配对已结束，没有产生新的设备授权。</p>
          <button type="button" className="arkme-remote-primary-button" disabled={busy || status?.connected !== true} onClick={createPairing}>重新生成</button>
        </div> : <div className="arkme-remote-pairing-content">
          <div className="arkme-remote-qr-frame">
            {qr !== undefined && <img src={qr.dataUrl} width={qr.displaySize} height={qr.displaySize} alt="远控配对二维码" />}
          </div>
          <div className="arkme-remote-pairing-guide">
            <ol><li><span>1</span><p><strong>打开手机端</strong><small>在 Arkme 设置中选择 DSH 远控</small></p></li>
              <li><span>2</span><p><strong>扫描二维码</strong><small>确认电脑名称后即可长期使用</small></p></li></ol>
            <div className="arkme-remote-code-block">
              <span>无法扫码？输入 8 位配对码</span>
              <button type="button" disabled={busy} aria-label={copied ? '配对码已复制' : `复制配对码 ${pairing.pairingCode}`} onClick={copyPairingCode}>
                <strong>{pairing.pairingCode}</strong>{copied ? <Check size={17} weight="bold" aria-hidden /> : <Copy size={17} aria-hidden />}
              </button>
            </div>
            <p className="arkme-remote-security-note"><ShieldCheck size={16} aria-hidden />配对码仅本次有效。绑定后只有你的账号和已授权设备可以访问。</p>
          </div>
        </div>}
        <footer>
          {!pairingExpired && <button type="button" disabled={busy || status?.connected !== true} onClick={createPairing}>换一个配对码</button>}
          <button type="button" disabled={busy} onClick={cancelPairing}>取消配对</button>
        </footer>
      </section>}

      <section className="arkme-remote-devices" aria-labelledby="arkme-remote-devices-title">
        <header><div><h2 id="arkme-remote-devices-title">已绑定手机</h2><p>这些设备无需再次配对，随时可以撤销权限</p></div>{visibleBindings.length > 0 && <span>{String(visibleBindings.length)} 台</span>}</header>
        {visibleBindings.length === 0 ? <div className="arkme-remote-empty">
          <span><DeviceMobile size={22} weight="duotone" aria-hidden /></span><strong>还没有绑定手机</strong><p>开启远控并添加手机后，即可随时继续 DSH 会话。</p>
        </div> : <div className="arkme-remote-device-list">
          {visibleBindings.map(binding => <article key={binding.bindingRef} className="arkme-remote-device-row">
            <span className="arkme-remote-device-icon"><DeviceMobile size={20} weight="duotone" aria-hidden /></span>
            <div><strong>{binding.controllerDisplayName}</strong><span>{platformLabel(binding.controllerPlatform)} · {formatDshRemoteDeviceActivity(binding, now)}</span></div>
            <span className={`arkme-remote-device-state is-${binding.status}`}>{binding.status === 'active' ? '已授权' : '已暂停'}</span>
            <button type="button" disabled={busy} aria-label={`撤销 ${binding.controllerDisplayName} 的远控权限`} title="撤销权限" onClick={() => { revoke(binding) }}><Trash size={16} aria-hidden /></button>
          </article>)}
        </div>}
      </section>

      {error !== '' && <div className="arkme-redesign-settings-error arkme-remote-error" role="alert">{error}</div>}
    </div>
  </div>
}
