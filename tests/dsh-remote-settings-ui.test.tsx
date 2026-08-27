import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArkmeRemoteSettingsPanel } from '../src/client/ArkmeRemoteSettingsPanel.js'

describe('DSH remote desktop settings', () => {
  it('provides the v4 remote switch, pairing and long-lived binding management entry points', () => {
    const markup = renderToStaticMarkup(<ArkmeRemoteSettingsPanel onBack={() => undefined} />)
    expect(markup).toContain('aria-label="远程控制设置"')
    expect(markup).toContain('远程控制')
    expect(markup).toContain('绑定新手机')
    expect(markup).toContain('二维码或 20 位一次性配对码')
    expect(markup).toContain('已绑定设备')
    expect(markup).toContain('完成一次配对后将长期保留，可随时撤销')
    expect(markup).not.toContain('ApiProxy')
  })
})
