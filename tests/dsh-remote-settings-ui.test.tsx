import { renderToStaticMarkup } from 'react-dom/server'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { ArkmeRemoteSettingsPanel, buildDshRemotePairingQr } from '../src/client/ArkmeRemoteSettingsPanel.js'

describe('DSH remote desktop settings', () => {
  it('provides the v4 remote switch, pairing and long-lived binding management entry points', () => {
    const markup = renderToStaticMarkup(<ArkmeRemoteSettingsPanel onBack={() => undefined} />)
    expect(markup).toContain('aria-label="远程控制设置"')
    expect(markup).toContain('远程控制')
    expect(markup).toContain('绑定新手机')
    expect(markup).toContain('二维码或 8 位一次性配对码')
    expect(markup).toContain('已绑定设备')
    expect(markup).toContain('完成一次配对后将长期保留，可随时撤销')
    expect(markup).not.toContain('ApiProxy')
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
