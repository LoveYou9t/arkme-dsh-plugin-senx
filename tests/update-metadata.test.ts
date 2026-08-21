import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRegistryPackageMetadata } from '../src/plugin-update.js'

describe('published update metadata', () => {
  it('ships a Registry-compatible bounded notice in package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      arkme?: { updateNotice?: unknown }
    }

    expect(parseRegistryPackageMetadata(manifest)).toEqual({
      version: manifest.version,
      notice: {
        schemaVersion: 1,
        level: 'normal',
        title: 'Arkme 插件 0.1.12 更新',
        summary: '恢复世界作者声纹朗读能力，并保持头像与媒体引用由本地 Provider 安全承接。',
        publishedAt: '2026-08-21T04:00:00.000Z',
        releaseNotesUrl: 'https://www.npmjs.com/package/@senguoyun/dsh-arkme',
      },
    })
  })
})
