import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const persistentShellSource = readFileSync(new URL('../src/client/ArkmePersistentShell.tsx', import.meta.url), 'utf8')

describe('Arkme persistent sidebar', () => {
  it('keeps the conversation directory visible while a Bot chat is focused', () => {
    expect(persistentShellSource).toContain("ui.mode === 'source' || ui.mode === 'bot' || ui.mode === 'arko' || harnessMode")
  })

  it('keeps a compact Arkme login entry visible on Web after logout', () => {
    expect(persistentShellSource).toContain("const webLoginMode = loginMode && !startupAuthGateEnabled()")
    expect(persistentShellSource).toContain('data-arkme-login-entry')
    expect(persistentShellSource).toContain('aria-label="Arkme 登录入口"')
    expect(persistentShellSource).toContain('arkmeUi.showLogin()')
    expect(persistentShellSource).toContain('style={{ ...styles.sidebar, width: 0 }}')
  })
})
