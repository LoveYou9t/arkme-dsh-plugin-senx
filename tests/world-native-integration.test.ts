import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = async (relativePath: string) => await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

describe('native World integration', () => {
  it('adds a first-party world UI mode and controller transition', async () => {
    const controller = await source('src/client/ui-controller.ts')

    expect(controller).toContain("| 'world'")
    expect(controller).toContain('showWorld(): void')
    expect(controller).toContain("mode: 'world'")
  })

  it('places World immediately below Calendar in the product navigation', async () => {
    const productNavigation = await source('src/client/ArkmeProductNavigation.tsx')

    expect(productNavigation).toMatch(/id: 'calendar'[\s\S]*id: 'world'[\s\S]*id: 'extensions'/)
    expect(productNavigation).toContain("if (id === 'world') arkmeUi.showWorld()")
  })

  it('renders World as a full native utility surface like recordings', async () => {
    const sidebar = await source('src/client/ArkmeSidebar.tsx')
    const clientIndex = await source('src/client/index.tsx')

    expect(sidebar).toContain("import { ArkmeWorldSurface } from './ArkmeWorldSurface.js'")
    expect(sidebar).toContain("ui.mode === 'world' ? '世界'")
    expect(sidebar).toContain("ui.mode === 'world'")
    expect(sidebar).toContain("<ArkmeWorldSurface />")
    expect(clientIndex).toContain("export { ArkmeWorldSurface } from './ArkmeWorldSurface.js'")
  })

  it('keeps the original currently unsupported controls wired to their real operations', async () => {
    const api = await source('src/client/api.ts')
    const world = await source('src/client/ArkmeWorldSurface.tsx')

    for (const operation of ['world.mine', 'world.upload-image-data', 'world.publish-rich', 'world.publish-text', 'world.voiceprint.invite']) {
      expect(api).toContain(`| '${operation}'`)
      expect(world).toContain(`'${operation}'`)
    }
    expect(world).toContain('草稿不会被清空')
  })
})
