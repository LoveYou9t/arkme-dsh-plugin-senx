import { renderToStaticMarkup } from 'react-dom/server'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  ArkmeRemoteSettingsPanel,
  DshRemotePairingDialog,
  buildDshRemotePairingQr,
  formatDshRemoteDeviceActivity,
} from '../src/client/ArkmeRemoteSettingsPanel.js'

const pairing = {
  pairingRef: 'pair_84748e7aae6f47ff90734f397fa14fdc',
  pairingChannelRef: 'pairing-channel-test',
  qrPayload: JSON.stringify({ scheme: 'jotmo-dsh-remote', version: 1, challenge: 'test' }),
  pairingCode: 'AT5Y-AZRD',
  hostKeyFingerprint: 'host-fingerprint',
  expiresAtMillis: 1_787_820_000_000,
  runtimeRef: 'runtime-test',
}

describe('DSH remote desktop settings', () => {
  it('provides the v4 remote switch, pairing and long-lived binding management entry points', () => {
    const markup = renderToStaticMarkup(<ArkmeRemoteSettingsPanel onBack={() => undefined} />)
    expect(markup).toContain('aria-label="远程控制设置"')
    expect(markup).toContain('移动端远控')
    expect(markup).toContain('可控制这台电脑的设备')
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-label="允许移动端远程控制"')
    expect(markup).toContain('添加')
    expect(markup).toContain('尚未添加设备')
    expect(markup).toContain('其他设置')
    expect(markup).toContain('电脑名称')
    expect(markup).not.toContain('ApiProxy')
  })

  it('keeps QR and manual code in a focused modal instead of the settings page', () => {
    const shared = {
      pairing,
      now: pairing.expiresAtMillis - 60_000,
      copied: false,
      busy: false,
      onModeChange: () => undefined,
      onCopy: () => undefined,
      onRegenerate: () => undefined,
      onClose: () => undefined,
    }
    const qrMarkup = renderToStaticMarkup(<DshRemotePairingDialog {...shared} mode="qr" />)
    const codeMarkup = renderToStaticMarkup(<DshRemotePairingDialog {...shared} mode="code" />)

    expect(qrMarkup).toContain('role="dialog"')
    expect(qrMarkup).toContain('aria-modal="true"')
    expect(qrMarkup).toContain('在手机上连接这台电脑')
    expect(qrMarkup).toContain('alt="远控配对二维码"')
    expect(qrMarkup).not.toContain(pairing.pairingCode)
    expect(codeMarkup).toContain(pairing.pairingCode)
    expect(codeMarkup).toContain(`aria-label="复制配对码 ${pairing.pairingCode}"`)
    expect(codeMarkup).not.toContain('alt="远控配对二维码"')
  })

  it('keeps binding activity human-readable without exposing internal refs', () => {
    const now = Date.UTC(2026, 7, 27, 8, 0, 0)
    const binding = {
      bindingRef: 'binding-secret-ref', controllerCredentialRef: 'credential-secret-ref',
      controllerDisplayName: 'Galaxy S24', controllerPlatform: 'android', revision: 1,
      status: 'active' as const, scopes: ['session.list'], boundAtMillis: now - 8 * 24 * 60 * 60_000,
      lastUsedAtMillis: now - 5 * 60_000,
    }

    expect(formatDshRemoteDeviceActivity(binding, now)).toBe('5 分钟前连接')
  })

  it('renders a decodable signed pairing payload with at least four display pixels per QR module', async () => {
    const payload = JSON.stringify({
      challenge: 'A'.repeat(43), environment: 'test', expires_at: 1_787_819_305_881,
      host_ephemeral_public_key: 'B'.repeat(43), host_fingerprint: 'C'.repeat(43),
      host_public_signing_key: 'D'.repeat(43), host_signature: 'E'.repeat(86),
      pairing_ref: 'pair_84748e7aae6f47ff90734f397fa14fdc', scheme: 'jotmo-dsh-remote', version: 1,
    })

    const qr = buildDshRemotePairingQr(payload)

    expect(qr.dataUrl).toMatch(/^data:image\/gif;base64,/)
    expect(qr.moduleCount).toBeLessThanOrEqual(80)
    expect(qr.displaySize / qr.moduleCount).toBeGreaterThanOrEqual(4)
    const image = await sharp(Buffer.from(qr.dataUrl.split(',')[1]!, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.info.width, image.info.height)
    expect(decoded?.data).toBe(payload)
  })
})
