import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArkmeMacOSSecureValueStore } from '../src/keychain-store.js'

const source = readFileSync(join(process.cwd(), 'src', 'keychain-store.ts'), 'utf8')

describe('remote Desktop Credential macOS storage', () => {
  it('passes the secret separately from security argv', async () => {
    const secret = '{"privateKey":"must-not-be-in-argv"}'
    const writer = vi.fn(async (_args: readonly string[], _payload: string) => undefined)
    const store = new ArkmeMacOSSecureValueStore('dev.jotmo.remote', writer, 'darwin')

    await store.write('account-1', secret)

    expect(writer).toHaveBeenCalledOnce()
    const [args, payload] = writer.mock.calls[0] ?? []
    expect(args).toEqual([
      'add-generic-password', '-a', 'account-1', '-s', 'dev.jotmo.remote', '-U', '-w',
    ])
    expect(args).not.toContain(secret)
    expect(args?.at(-1)).toBe('-w')
    expect(payload).toBe(secret)
  })

  it('feeds the macOS security prompts through a private pseudo-terminal', () => {
    expect(source).toContain("spawn('/usr/bin/expect', ['-c', MACOS_KEYCHAIN_EXPECT_SCRIPT]")
    expect(source).toContain('retype password for new item:')
    expect(source).not.toContain("spawn('/usr/bin/security', [...args]")
  })
})
