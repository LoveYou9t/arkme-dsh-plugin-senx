import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DshApiProxyAdapter, type DshPublicApiProxyLike } from '../src/dsh-remote/api-proxy-adapter.js'
import { encryptDshRemotePayload } from '../src/dsh-remote/protocol-v1.js'
import { dshRemoteFrameByteLengths } from '../src/dsh-remote/realtime-transport.js'
import { DSH_REMOTE_MAX_FRAME_BYTES, DSH_REMOTE_MAX_PAGE_RESULT_BYTES } from '../src/dsh-remote/types.js'

function ok<T>(value: T, rpcId = 'rpc') { return { rpcId, result: { ok: true as const, value } } }

function expectFitsEncryptedFrames(operation: 'session.list' | 'session.history' | 'snapshot.get', result: unknown): void {
  const response = {
    protocol: 'dsh.remote', protocol_major: 1, kind: 'response', request_ref: 'r'.repeat(128),
    status: 'completed', host_generation: Number.MAX_SAFE_INTEGER, issued_at: Number.MAX_SAFE_INTEGER,
    operation, body: {}, result,
  }
  const payload = encryptDshRemotePayload(Buffer.alloc(32, 4), response, {
    keyEpoch: 1, direction: 'host-to-controller', nonce: Buffer.alloc(24, 7),
  })
  const sizes = dshRemoteFrameByteLengths({
    channelRef: 'c'.repeat(128), authorizationRef: 'a'.repeat(128), commandId: `response_${'r'.repeat(128)}`,
    direction: 'response', payload, senderRole: 'host', senderCredentialRef: 'd'.repeat(128),
    subjectRevision: Number.MAX_SAFE_INTEGER, remoteAuthEpoch: Number.MAX_SAFE_INTEGER,
    targetHostLeaseGeneration: Number.MAX_SAFE_INTEGER,
  })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(DSH_REMOTE_MAX_PAGE_RESULT_BYTES)
  expect(sizes.publish).toBeLessThanOrEqual(DSH_REMOTE_MAX_FRAME_BYTES)
  expect(sizes.event).toBeLessThanOrEqual(DSH_REMOTE_MAX_FRAME_BYTES)
}

async function fakeApi(): Promise<{ api: DshPublicApiProxyLike; prompt: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh remote workspace '))
  await mkdir(join(directory, 'project'))
  const prompt = vi.fn(async (request: { rpcId: string }) => ok({ accepted: true as const }, request.rpcId))
  const cancel = vi.fn(async (request: { rpcId: string }) => ok({ accepted: true as const }, request.rpcId))
  return {
    prompt,
    cancel,
    api: {
      workspace: { list: async request => ok({
        items: [{ workspaceId: 'workspace-1', path: join(directory, 'project'), title: 'Project', sessionIds: ['session-1'] }],
        archivedSessionIds: [],
      }, request.rpcId) },
      sessions: {
        list: async request => ok({ items: [{
          sessionId: 'session-1', updatedAt: 100, running: true, blank: false,
          projections: { asOfSeq: 8, values: { title: 'Remote Session' } },
        }] }, request.rpcId),
        create: async request => ok({ sessionId: request.payload.sessionId }, request.rpcId),
        history: async request => ok({
          events: [{ event: { type: 'user/message', seq: 8, time: 100, data: { text: 'hello' } } }],
          hasMore: false, projections: { asOfSeq: 8, values: {} },
        }, request.rpcId),
        prompt,
        cancel,
      },
    },
  }
}

describe('public DSH ApiProxy remote adapter', () => {
  it('feature-detects only public capabilities and projects registered workspaces', async () => {
    const { api } = await fakeApi()
    const adapter = new DshApiProxyAdapter(api)
    expect(adapter.capabilities()).toContain('workspace.list')
    expect(adapter.capabilities()).not.toContain('interaction.approval.respond')
    await expect(adapter.snapshot()).resolves.toMatchObject({
      workspaces: [{ workspaceId: 'workspace-1', available: true }],
      sessions: [{ sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Remote Session' }],
    })
  })

  it('preallocates a stable SessionId and never accepts cwd from the controller', async () => {
    const { api } = await fakeApi()
    const adapter = new DshApiProxyAdapter(api)
    const first = await adapter.createSession({ workspaceId: 'workspace-1', requestRef: 'request-1', dshRpcId: 'rpc-1' })
    const second = await adapter.createSession({ workspaceId: 'workspace-1', requestRef: 'request-1', dshRpcId: 'rpc-1' })
    expect(second.sessionId).toBe(first.sessionId)
    expect(first.sessionId).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('forwards bounded text with explicit queue/steer and rejects attachments and slash commands first', async () => {
    const { api, prompt } = await fakeApi()
    const adapter = new DshApiProxyAdapter(api)
    await adapter.prompt({ sessionId: 'session-1', mode: 'steer', content: [{ type: 'text', text: 'guide now' }], dshRpcId: 'rpc-1' })
    expect(prompt).toHaveBeenCalledWith({ rpcId: 'rpc-1', payload: {
      sessionId: 'session-1', mode: 'steer', content: [{ type: 'text', text: 'guide now' }],
    } })
    await expect(adapter.prompt({
      sessionId: 'session-1', mode: 'queue', content: [{ type: 'image', data: 'secret' }], dshRpcId: 'rpc-2',
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(adapter.prompt({
      sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: '/approve everything' }], dshRpcId: 'rpc-3',
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('treats cancel on an idle Session as idempotent success', async () => {
    const { api, cancel } = await fakeApi()
    api.sessions!.list = async request => ok({ items: [{ sessionId: 'session-1', updatedAt: 100, running: false, blank: false }] }, request.rpcId)
    const adapter = new DshApiProxyAdapter(api)
    await expect(adapter.cancel({ sessionId: 'session-1', dshRpcId: 'rpc-1' })).resolves.toEqual({ accepted: true })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('fails closed for allowed-once when rc.7 cannot project a complete approval view', async () => {
    const { api } = await fakeApi()
    async function* mux() {
      yield { rpcId: 'approval-rpc', payload: {
        type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'shell', reason: 'run command',
      } }
      await new Promise(() => undefined)
    }
    api.events = { mux: () => mux() }
    api.respond = vi.fn(async () => ({ accepted: true as const }))
    const adapter = new DshApiProxyAdapter(api)
    const stop = adapter.startEvents()
    await vi.waitFor(() => { expect(adapter.pending()).toHaveLength(1) })
    await expect(adapter.answerApproval({
      interactionRpcRef: 'approval-rpc', sessionId: 'session-1', approvalId: 'approval-1', outcome: 'allowed-once',
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(adapter.answerApproval({
      interactionRpcRef: 'approval-rpc', sessionId: 'session-1', approvalId: 'approval-1', outcome: 'rejected',
    })).resolves.toBeUndefined()
    stop()
  })

  it('projects only bounded text and exact rpcId while replacing attachment and unknown payloads', async () => {
    const { api } = await fakeApi()
    api.sessions!.history = async request => ok({
      events: [
        { event: { type: 'user/message', seq: 1, time: 1, data: {
          content: [
            { type: 'text', text: 'safe text' },
            { type: 'image', data: 'base64-secret-image' },
            { type: 'future-block', raw: 'secret-unknown' },
          ],
          source: { kind: 'user', rpcId: 'remote_exact_rpc', private: 'hidden' },
        } } },
        { event: { type: 'tool/call', seq: 2, time: 2, data: { args: { token: 'secret-tool-args' } } }, view: { html: 'secret-view' } },
      ],
      hasMore: false,
    }, request.rpcId)
    const adapter = new DshApiProxyAdapter(api)
    const page = await adapter.history({ sessionId: 'session-1' })
    expect(page.entries[0]).toMatchObject({ event: { data: {
      content: [
        { type: 'text', text: 'safe text' },
        { type: 'unsupported', reason: 'attachment' },
        { type: 'unsupported', reason: 'unknown-content' },
      ],
      source: { kind: 'user', rpcId: 'remote_exact_rpc' },
    } } })
    const encoded = JSON.stringify(page)
    expect(encoded).not.toContain('base64-secret-image')
    expect(encoded).not.toContain('secret-unknown')
    expect(encoded).not.toContain('secret-tool-args')
    expect(encoded).not.toContain('secret-view')
    expect(adapter.historyContainsRpcId(page.entries, 'remote_exact_rpc')).toBe(true)
    expect(adapter.historyContainsRpcId(page.entries, 'safe text')).toBe(false)
  })

  it('paginates list/history/snapshot by item count, cursor and encrypted outer-frame budget', async () => {
    const { api } = await fakeApi()
    const sessionIds = Array.from({ length: 50 }, (_, index) => `session-${String(index).padStart(3, '0')}-${'s'.repeat(230)}`)
    api.workspace!.list = async request => ok({ items: [{
      workspaceId: `workspace-${'w'.repeat(240)}`, path: process.cwd(), title: 'Large Project', sessionIds,
    }] }, request.rpcId)
    api.sessions!.list = async request => ok({ items: sessionIds.map((sessionId, index) => ({
      sessionId, updatedAt: 10_000 - index, running: false, blank: false,
      projections: { asOfSeq: index + 1, values: { title: '🙂'.repeat(100) } },
    })) }, request.rpcId)
    api.sessions!.history = async request => ok({
      events: Array.from({ length: 50 }, (_, index) => ({ event: {
        type: 'assistant/message', seq: index + 1, time: index + 1,
        data: { content: [{ type: 'text', text: '四'.repeat(20_000) }] },
      } })),
      hasMore: false,
    }, request.rpcId)
    const adapter = new DshApiProxyAdapter(api)

    const list = await adapter.sessions({ limit: 50 })
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.length).toBeLessThan(50)
    expect(list.nextCursor).toBeTruthy()
    expectFitsEncryptedFrames('session.list', list)
    await expect(adapter.cancel({ sessionId: sessionIds.at(-1)!, dshRpcId: 'rpc-last-page' }))
      .resolves.toEqual({ accepted: true })

    const history = await adapter.history({ sessionId: sessionIds[0]!, limit: 50 })
    expect(history.entries.length).toBeGreaterThan(0)
    expect(history.entries.length).toBeLessThan(50)
    expect(history.nextCursor).toBeTypeOf('number')
    expectFitsEncryptedFrames('session.history', history)

    const snapshot = await adapter.snapshot({ limit: 50 })
    expect(snapshot.nextCursor).toBeTruthy()
    expectFitsEncryptedFrames('snapshot.get', snapshot)
  })

  it('recovers a failed public event mux with bounded backoff and stop prevents another subscription', async () => {
    const { api } = await fakeApi()
    let calls = 0
    api.events = { mux: (_request, signal) => (async function* () {
      calls++
      if (calls === 1) throw new Error('first mux failed')
      yield { rpcId: 'question-replayed-01', payload: {
        type: 'question/requested', sessionId: 'session-1', questions: [{
          id: 'continue', question: '继续吗？', options: [{ label: '继续' }], private: 'not projected',
        }],
      } }
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })() }
    const adapter = new DshApiProxyAdapter(api, { eventRetryBaseMillis: 10 })
    const stop = adapter.startEvents()
    await vi.waitFor(() => {
      expect(calls).toBe(2)
      expect(adapter.pending()).toMatchObject([{ questions: [{ id: 'continue', question: '继续吗？' }] }])
      expect(JSON.stringify(adapter.pending())).not.toContain('not projected')
    })
    stop()
    await new Promise(resolve => { setTimeout(resolve, 30) })
    expect(calls).toBe(2)
  })
})
