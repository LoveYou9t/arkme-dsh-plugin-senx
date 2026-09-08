import type { ArkmeConversationMemberItem, ArkmeConversationMemberJoinEvent } from './types.js'

/** Basic membership pages cannot erase presentation that is still being hydrated. */
export function mergeMemberPresentation(previous: ArkmeConversationMemberItem | undefined, incoming: ArkmeConversationMemberItem, complete: boolean): ArkmeConversationMemberItem {
  if (previous === undefined || complete) return incoming
  return { ...previous, role: incoming.role, status: incoming.status, joinedAtMillis: incoming.joinedAtMillis,
    isSelf: incoming.isSelf, isOwner: incoming.isOwner,
    ...(incoming.memberName === undefined ? {} : { memberName: incoming.memberName }) }
}

/** One join event can span multiple member pages. Keep every known invitee. */
export function mergeMemberJoinEvents(previous: readonly ArkmeConversationMemberJoinEvent[], incoming: readonly ArkmeConversationMemberJoinEvent[]): ArkmeConversationMemberJoinEvent[] {
  const events = new Map(previous.map(event => [event.eventId, event]))
  for (const event of incoming) {
    const old = events.get(event.eventId)
    const invitees = new Map((old?.invitees ?? []).map(person => [person.memberRef ?? person.displayName, person]))
    for (const person of event.invitees) invitees.set(person.memberRef ?? person.displayName, person)
    events.set(event.eventId, { ...event, invitees: [...invitees.values()] })
  }
  return [...events.values()].slice(-2_000)
}
