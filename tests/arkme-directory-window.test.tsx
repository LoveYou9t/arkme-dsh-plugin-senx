import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { ArkmeDirectoryWindow } from '../src/client/ArkmeDirectoryWindow.js'

it('mounts only the initial directory chunk and keeps an offscreen selected row available', () => {
  const rows = Array.from({ length: 240 }, (_, index) => <button key={String(index)}>Row {index}</button>)
  let view: ReturnType<typeof create>
  act(() => { view = create(<ArkmeDirectoryWindow>{rows}</ArkmeDirectoryWindow>) })
  expect(view!.root.findAllByType('button')).toHaveLength(20)
  act(() => { view!.update(<ArkmeDirectoryWindow activeKey="201">{rows}</ArkmeDirectoryWindow>) })
  expect(view!.root.findAllByType('button')).toHaveLength(40)
  expect(view!.root.findAllByType('button').some(row => row.props.children[1] === 201)).toBe(true)
  act(() => { view!.unmount() })
})
