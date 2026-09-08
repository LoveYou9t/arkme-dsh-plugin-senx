import type { ArkmeSourceItem } from './types.js'

/** Policy freshness is independent of message sequence and event delivery order. */
export function retainNewerArkmeChatPin(
  current: ArkmeSourceItem | undefined,
  incoming: ArkmeSourceItem,
): ArkmeSourceItem {
  if ((incoming.kind !== 'private_chat' && incoming.kind !== 'group_chat')
    || current?.kind !== incoming.kind || current.isPinned === undefined
    || current.chatPolicyUpdatedAtMillis === undefined
    || current.chatPolicyUpdatedAtMillis <= (incoming.chatPolicyUpdatedAtMillis ?? 0)) return incoming
  return {
    ...incoming,
    isPinned: current.isPinned,
    chatPolicyUpdatedAtMillis: current.chatPolicyUpdatedAtMillis,
  }
}
