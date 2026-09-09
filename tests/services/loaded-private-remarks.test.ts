import { describe, expect, it, vi } from 'vitest'
import { SourceService } from '../../src/services/source-service.js'
import type { ServiceRuntime } from '../../src/services/service.js'

function setup() {
  const request = vi.fn(() => { throw new Error('loaded remarks must not read the network') })
  const runtime = { authenticatedChatPost: request } as unknown as ServiceRuntime
  return { source: new SourceService(runtime, {} as never, {} as never), request }
}

describe('loaded private remark projection', () => {
  it('reads only known remarks for the viewer, retaining a confirmed empty value', () => {
    const { source, request } = setup()
    source.rememberPrivateRemark(1, 2, '私人备注', 100)
    source.rememberPrivateRemark(9, 2, '其他查看者备注', 200)
    expect(source.loadedPrivateRemarksByUserIds(1, [2, 3])).toEqual(new Map([[2, '私人备注']]))
    source.rememberPrivateRemark(1, 2, '', 300)
    source.rememberPrivateRemark(1, 2, '旧备注', 200)
    expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '']]))
    expect(source.loadedPrivateRemarksByUserIds(9, [2])).toEqual(new Map([[2, '其他查看者备注']]))
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds the projection and clears it on disposal', () => {
    const { source } = setup()
    for (let userId = 2; userId <= 1002; userId++) source.rememberPrivateRemark(1, userId, `备注${userId}`, userId)
    expect(source.loadedPrivateRemarksByUserIds(1, [2, 1002])).toEqual(new Map([[1002, '备注1002']]))
    source.dispose()
    expect(source.loadedPrivateRemarksByUserIds(1, [1002])).toEqual(new Map())
  })
})

function bundle(remark: string | undefined, updatedAtMillis: number, kind = 1) {
  return { session: { chat_session_uid: 'private-2', session_kind: kind }, private_counterpart: { user_id: 2 },
    private_supplement: { status: 1, updated_at: updatedAtMillis, ...(remark === undefined ? {} : { remark }),
      counterpart_name_snapshot: '不能作为备注的名称快照' } }
}

it('learns exact remarks from ordinary list and detail reads without treating snapshots as remarks', async () => {
  let current = bundle('列表备注', 100)
  let epoch = 0
  let release: (() => void) | undefined
  const request = vi.fn(async () => { const captured = current; if (release !== undefined) await new Promise<void>(resolve => { release = resolve }); return { items: [captured], has_more: false } })
  const session = { userId: 1, accessToken: 'access', refreshToken: 'refresh' }
  const runtime = { requireSession: async () => session, memberCacheEpoch: () => epoch,
    stateStore: { uniqueCode: async () => 'test-secret' }, authenticatedChatPost: request } as unknown as ServiceRuntime
  const source = new SourceService(runtime, {} as never, {} as never)
  await source.listSources('root', { firstPaint: true })
  expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '列表备注']]))
  await source.chatSourceFromBundle(bundle(undefined, 200), session, undefined, [])
  expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '']]))
  await source.chatSourceFromBundle(bundle('迟到旧详情', 150), session, undefined, [])
  expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '']]))
  await source.chatSourceFromBundle(bundle('群名不能作私人备注', 300, 2), session, undefined, [])
  expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '']]))
  current = bundle('旧列表', 250)
  release = () => {}
  const pending = source.listSources('root', { firstPaint: true, refresh: true })
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  source.rememberPrivateRemark(1, 2, '刚保存', 400)
  epoch++
  release!()
  await pending
  expect(source.loadedPrivateRemarksByUserIds(1, [2])).toEqual(new Map([[2, '刚保存']]))
  expect(request).toHaveBeenCalledTimes(2)
  source.dispose()
})
