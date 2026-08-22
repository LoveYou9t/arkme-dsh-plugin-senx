import { Context } from '@deepseek-ai/cordis'
import * as cordisModule from '@deepseek-ai/cordis'
import * as slotsModule from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'
import { arkmeUi } from '../src/client/ui-controller.js'

type RuntimeModule = {
  SlotRegistry: new (ctx: Context) => {
    entries(key: string): readonly unknown[]
    inject(key: string, callback: () => (() => void)): () => void
    register(options: unknown, component: () => null): () => void
    spec(key: string): unknown
  }
}

async function loadSlotRegistry(): Promise<RuntimeModule['SlotRegistry']> {
  let runtime: RuntimeModule | undefined
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __ModuleLoader__: {
        load(definition: { factory(require: (id: string) => unknown): RuntimeModule }) {
          runtime = definition.factory(id => {
            if (id === '@deepseek-ai/cordis') return cordisModule
            if (id === '@deepseek-ai/dsh-client-ui-slots') return slotsModule
            throw new Error(`unexpected runtime dependency: ${id}`)
          })
        },
      },
    },
  })
  try {
    await import('@deepseek-ai/dsh-client-runtime/client')
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
  if (runtime === undefined) throw new Error('DSH client runtime did not register with the module loader')
  return runtime.SlotRegistry
}

afterEach(() => {
  vi.useRealTimers()
  arkmeUi.showConversations()
})

describe('Arkme directory slot lifecycle', () => {
  it('restarts directory consumers exactly once when the official settings sidebar returns', async () => {
    vi.useFakeTimers()
    const SlotRegistry = await loadSlotRegistry()
    const registry = new SlotRegistry(new Context())
    const disposeFrame = registry.register({
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        conversation: { kind: 'single', scope: 'session' },
        details: { kind: 'single', scope: 'session-maybe' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, () => null)

    let consumerActivations = 0
    let consumerDisposals = 0
    const stopConsumer = registry.inject('arkme.directory.entry', () => {
      consumerActivations += 1
      const disposeEntry = registry.register({
        name: 'arkme.directory.entry',
        id: 'test-directory-consumer',
      }, () => null)
      return () => {
        consumerDisposals += 1
        disposeEntry()
      }
    })

    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
        clearInterval: (timer: ReturnType<typeof setInterval>) => globalThis.clearInterval(timer),
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: vi.fn(() => null) },
    })

    const pluginCleanups: Array<() => void> = []
    try {
      apply({
        slots: registry,
        layout: { toggleSidebar: vi.fn(), closeDetails: vi.fn() },
        effect: (factory: () => unknown, label: string) => {
          if (!label.includes('embedded DeepSeek Harness') && !label.includes('official settings sidebar')) return () => {}
          const cleanup = factory()
          if (typeof cleanup === 'function') pluginCleanups.push(cleanup)
          return typeof cleanup === 'function' ? cleanup : () => {}
        },
      } as never)

      expect(consumerActivations).toBe(1)
      expect(registry.entries('arkme.directory.entry')).toHaveLength(1)

      arkmeUi.openDshSettings()

      expect(registry.spec('arkme.directory.entry')).toBeUndefined()
      expect(registry.entries('arkme.directory.entry')).toHaveLength(0)
      expect(consumerDisposals).toBe(1)

      vi.advanceTimersByTime(2_000)

      expect(registry.entries('arkme.directory.entry')).toHaveLength(1)
      expect(consumerActivations).toBe(2)
      expect(consumerDisposals).toBe(1)

      vi.advanceTimersByTime(500)
      expect(consumerActivations).toBe(2)
      expect(registry.entries('arkme.directory.entry')).toHaveLength(1)
    } finally {
      pluginCleanups.reverse().forEach(cleanup => { cleanup() })
      stopConsumer()
      disposeFrame()
      if (previousWindow === undefined) delete (globalThis as { window?: Window }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
      if (previousDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    }
  })
})
