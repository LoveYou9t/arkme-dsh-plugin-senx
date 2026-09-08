import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('conversation composer redesign styles', () => {
  it('lets the primary Arkme composer focus state override redesign important rules', async () => {
    const css = await readFile(new URL('../src/client/redesign/arkme-redesign.css', import.meta.url), 'utf8')

    expect(css).toMatch(/\.arkme-redesign-route-chats \.arkme-conversation-composer-inner\[data-arkme-primary-composer="true"\]\s*\{[^}]*box-shadow:\s*none !important;/s)
    expect(css).toMatch(/\.arkme-redesign-route-chats \.arkme-conversation-composer-inner\[data-arkme-primary-composer="true"\]\[data-arkme-composer-focused="true"\]\s*\{[^}]*background:\s*var\(--arkme-primary-composer-focused, #ffffff\) !important;/s)
    expect(css).toContain('--arkme-primary-composer-idle: #f6f6f6;')
    expect(css).toContain('--arkme-primary-composer-focused: #ffffff;')
    expect(css).toContain('--arkme-primary-composer-idle: #151515;')
    expect(css).toContain('--arkme-primary-composer-focused: #000000;')
    expect(css).toMatch(/body\[data-ds-dark-theme\] \.arkme-redesign-route-chats \.arkme-conversation-composer-inner\[data-arkme-primary-composer="true"\]\s*\{[^}]*box-shadow:\s*none !important;/s)
  })
})
