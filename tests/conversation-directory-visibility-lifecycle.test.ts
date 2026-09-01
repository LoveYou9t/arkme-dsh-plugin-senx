import { describe, expect, it, vi } from 'vitest'
import { ArkmeService } from '../src/arkme-service.js'
import type { ArkmeSourceItem } from '../src/types.js'

const source: ArkmeSourceItem = {
  sourceRef: 'source-ref',
  kind: 'private_chat',
  displayName: 'Bot conversation',
  activeAtMillis: 100,
  unreadCount: 0,
}

describe('conversation directory visibility lifecycle', () => {
  it('captures the direct Bot identity before opening can replace it with a Chat session', async () => {
    const events: string[] = []
    let currentRef = { entityKind: 2 as const, entityUid: 'bot-1' }
    let finishRestore: (() => void) | undefined
    const restoreSource = vi.fn(async () => {
      await new Promise<void>(resolve => { finishRestore = resolve })
    })
    const facade = {
      bot: {
        botConversationListPreferenceEntry: vi.fn(async () => {
          events.push('identity')
          return {
            ownerUserId: 42,
            ref: currentRef,
            evidence: { sequence: 0, activityAtMillis: 100 },
          }
        }),
        openBotChat: vi.fn(async () => {
          events.push('open')
          currentRef = { entityKind: 1, entityUid: 'chat-1' }
          return source
        }),
      },
      conversationDirectoryVisibility: { restoreSource },
    } as unknown as ArkmeService

    await expect(ArkmeService.prototype.openBotChat.call(facade, 'bot-ref')).resolves.toBe(source)
    await vi.waitFor(() => { expect(restoreSource).toHaveBeenCalledOnce() })

    expect(events).toEqual(['identity', 'open'])
    expect(restoreSource).toHaveBeenCalledWith(
      source,
      undefined,
      [{ entityKind: 2, entityUid: 'bot-1' }],
    )
    finishRestore?.()
  })

  it('restores a conversation opened from every contact entry without delaying navigation', async () => {
    let finishRestore: (() => void) | undefined
    const restoreSource = vi.fn(async () => {
      await new Promise<void>(resolve => { finishRestore = resolve })
    })
    const result = { source, created: false }
    const facade = {
      runtime: { requireSession: vi.fn(async () => ({ userId: 42 })) },
      contact: { resolveRegisteredContactUserId: vi.fn(async () => 84) },
      chat: { openPrivateChatFromUser: vi.fn(async () => result) },
      conversationDirectoryVisibility: { restoreSource },
    } as unknown as ArkmeService

    await expect(ArkmeService.prototype.openPrivateChatFromContact.call(facade, 'contact-ref'))
      .resolves.toBe(result)
    expect(restoreSource).toHaveBeenCalledWith(source)
    expect(finishRestore).toBeTypeOf('function')
    finishRestore?.()
  })

  it('does not restore a Bot that is opened through the ordinary sidebar operation', async () => {
    const conversation = { messages: [] }
    const setVisibility = vi.fn(async () => undefined)
    const facade = {
      botConversation: { open: vi.fn(async () => conversation) },
      conversationDirectoryVisibility: { setVisibility },
    } as unknown as ArkmeService

    await expect(ArkmeService.prototype.openBotPrivateChat.call(facade, 'bot-ref'))
      .resolves.toBe(conversation)
    expect(setVisibility).not.toHaveBeenCalled()
  })

})
