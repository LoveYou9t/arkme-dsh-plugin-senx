import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import type { DshRemoteBindingProjection, DshRemotePairingTicket, DshRemoteStatus } from '../dsh-remote/types.js'
import { callArkme } from './api.js'

function qrData(payload: string): string {
  const code = qrcode(0, 'M')
  code.addData(payload)
  code.make()
  return code.createDataURL(5, 2)
}

export function ArkmeRemoteSettingsPanel({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<DshRemoteStatus>()
  const [pairing, setPairing] = useState<DshRemotePairingTicket>()
  const [bindings, setBindings] = useState<DshRemoteBindingProjection[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const qr = useMemo(() => pairing === undefined ? undefined : qrData(pairing.qrPayload), [pairing?.qrPayload])

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
  }) }
  const cancelPairing = () => { if (pairing !== undefined) void run(async () => {
    await callArkme('remote.cancelPairingAttempt', { pairingRef: pairing.pairingRef })
    setPairing(undefined)
  }) }
  const rename = () => {
    const displayName = window.prompt('电脑名称', '')?.trim() ?? ''
    if (displayName === '') return
    void run(async () => { setStatus(await callArkme<DshRemoteStatus>('remote.renameDesktop', { displayName })) })
  }
  const revoke = (binding: DshRemoteBindingProjection) => {
    if (!window.confirm(`撤销“${binding.controllerDisplayName}”的远控权限？`)) return
    void run(async () => {
      await callArkme('remote.revokeBinding', { bindingRef: binding.bindingRef })
      setBindings(await callArkme<DshRemoteBindingProjection[]>('remote.listBindings'))
    })
  }

  const seconds = pairing === undefined ? 0 : Math.max(0, Math.ceil((pairing.expiresAtMillis - now) / 1000))
  return <div className="arkme-redesign-settings-surface" data-arkme-remote-settings aria-label="远程控制设置">
    <div className="arkme-redesign-settings-shell">
      <button type="button" className="arkme-redesign-setting-row" onClick={onBack}><strong>返回设置</strong><span /></button>
      <section className="arkme-redesign-settings-group"><h2>远程控制</h2><div>
        <div className="arkme-redesign-setting-row"><strong>{status?.enabled === true ? '已开启' : '未开启'}</strong><span className="arkme-redesign-setting-summary">{status?.connected === true ? '电脑已连接远控服务' : status?.unavailableReason ?? '开启后可与移动端长期绑定'}</span><button type="button" disabled={busy || status?.available !== true} onClick={toggle}>{status?.enabled === true ? '关闭' : '开启'}</button></div>
        <button type="button" className="arkme-redesign-setting-row" disabled={busy || status?.connected !== true} onClick={createPairing}><strong>{pairing === undefined ? '绑定新手机' : '刷新配对票据'}</strong><span className="arkme-redesign-setting-summary">二维码或 20 位一次性配对码</span></button>
        <button type="button" className="arkme-redesign-setting-row" disabled={busy} onClick={rename}><strong>电脑名称</strong><span className="arkme-redesign-setting-summary">修改移动端显示名称</span></button>
      </div></section>
      {pairing !== undefined && seconds > 0 && <section className="arkme-redesign-settings-group"><h2>配对（{String(seconds)} 秒后失效）</h2><div style={{ padding: 16, textAlign: 'center' }}>
        {qr !== undefined && <img src={qr} width={220} height={220} alt="远控配对二维码" />}
        <p style={{ fontSize: 20, letterSpacing: 2, userSelect: 'all' }}>{pairing.pairingCode}</p>
        <button type="button" disabled={busy} onClick={cancelPairing}>取消本次配对</button>
      </div></section>}
      <section className="arkme-redesign-settings-group"><h2>已绑定设备</h2><div>
        {bindings.length === 0 && <div className="arkme-redesign-setting-row"><strong>暂无设备</strong><span className="arkme-redesign-setting-summary">完成一次配对后将长期保留，可随时撤销</span></div>}
        {bindings.map(binding => <div key={binding.bindingRef} className="arkme-redesign-setting-row"><strong>{binding.controllerDisplayName}</strong><span className="arkme-redesign-setting-summary">{binding.controllerPlatform} · {binding.status === 'active' ? '已授权' : '已撤销'}</span>{binding.status === 'active' && <button type="button" disabled={busy} onClick={() => { revoke(binding) }}>撤销</button>}</div>)}
      </div></section>
      {error !== '' && <div className="arkme-redesign-settings-error" role="alert">{error}</div>}
    </div>
  </div>
}
