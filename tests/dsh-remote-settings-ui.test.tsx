import { renderToStaticMarkup } from 'react-dom/server'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  ArkmeRemoteSettingsPanel,
  buildDshRemotePairingQr,
  formatDshRemoteDeviceActivity,
} from '../src/client/ArkmeRemoteSettingsPanel.js'

describe('DSH remote desktop settings', () => {
  it('provides the v4 remote switch, pairing and long-lived binding management entry points', () => {
    const markup = renderToStaticMarkup(<ArkmeRemoteSettingsPanel onBack={() => undefined} />)
    expect(markup).toContain('aria-label="远程控制设置"')
    expect(markup).toContain('移动端远控')
    expect(markup).toContain('在手机上继续这台电脑里的 DSH 会话')
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-label="允许移动端远程控制"')
    expect(markup).toContain('添加手机')
    expect(markup).toContain('已绑定手机')
    expect(markup).toContain('这些设备无需再次配对，随时可以撤销权限')
    expect(markup).toContain('还没有绑定手机')
    expect(markup).not.toContain('ApiProxy')
  })

  it('keeps binding activity human-readable without exposing internal refs', () => {
    const now = Date.UTC(2026, 7, 27, 8, 0, 0)
    const binding = {
      bindingRef: 'binding-secret-ref', controllerCredentialRef: 'credential-secret-ref',
      controllerDisplayName: 'Galaxy S24', controllerPlatform: 'android', revision: 1,
      status: 'active' as const, scopes: ['session.list'], boundAtMillis: now - 8 * 24 * 60 * 60_000,
      lastUsedAtMillis: now - 5 * 60_000,
    }

    expect(formatDshRemoteDeviceActivity(binding, now)).toBe('5 分钟前使用')
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
