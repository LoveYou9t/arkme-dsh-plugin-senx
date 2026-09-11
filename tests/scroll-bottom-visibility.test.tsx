import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollBottomVisibility } from '../src/client/use-scroll-bottom-visibility.js'

describe('scroll bottom visibility (not auto-follow or unread state)', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals() })

  it('uses the strict 100px boundary without changing scroll position', () => {
    const body = { scrollTop: 800, scrollHeight: 1500, clientHeight: 600 }
    const viewport = { current: body as HTMLElement }
    const content = { current: null }
    function Harness({ active = true }: { active?: boolean }) {
      const control = useScrollBottomVisibility(viewport, content, active, 0)
      return <button hidden={!control.visible} onClick={control.measure} />
    }
    act(() => { renderer = create(<Harness />) })
    const visible = () => !renderer!.root.findByType('button').props.hidden
    expect(visible()).toBe(false)
    act(() => { body.scrollTop = 799; renderer!.root.findByType('button').props.onClick() })
    expect(visible()).toBe(true)
    expect(body.scrollTop).toBe(799)
    act(() => { renderer!.update(<Harness active={false} />) })
    expect(visible()).toBe(false)
    act(() => { body.clientHeight = 0; renderer!.update(<Harness />) })
    expect(visible()).toBe(false)
    act(() => { body.clientHeight = 1600; body.scrollTop = 0; renderer!.update(<Harness />) })
    expect(visible()).toBe(false)
  })

  it('remeasures viewport and async content resize, and releases observers', () => {
    let resized = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = observe
      disconnect = disconnect
    })
    const body = { scrollTop: 900, scrollHeight: 1500, clientHeight: 600 }
    const viewport = { current: body as HTMLElement }
    const content = { current: {} as HTMLElement }
    function Harness({ revision = 0 }: { revision?: number }) {
      const control = useScrollBottomVisibility(viewport, content, true, revision)
      return <span>{String(control.visible)}</span>
    }
    act(() => { renderer = create(<Harness />) })
    expect(observe.mock.calls.map(([element]) => element)).toEqual([body, content.current])
    act(() => { body.scrollHeight = 1700; resized() })
    expect(renderer!.root.findByType('span').children).toEqual(['true'])
    expect(body.scrollTop).toBe(900)
    act(() => { body.clientHeight = 800; resized() })
    expect(renderer!.root.findByType('span').children).toEqual(['false'])
    act(() => { renderer!.update(<Harness revision={1} />) })
    expect(disconnect).toHaveBeenCalledTimes(1)
    act(() => { renderer!.unmount() })
    renderer = undefined
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
