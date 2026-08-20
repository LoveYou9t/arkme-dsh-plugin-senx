import type {
  ArkmeDSHBetaCommunityEntryState,
  ArkmeDSHBetaCommunityJoinResult,
  ArkmeDSHBetaCommunityStatus,
} from '../dsh-beta-community.js'
import type { ArkmeGroupAvatarPresentation, ArkmeSourceItem } from '../types.js'
import { ProfileService } from './profile-service.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'
import { SourceService } from './source-service.js'

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanValue(value: unknown): boolean { return value === true }
function listValue(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

export class CommunityService {
  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
    private readonly profile: ProfileService,
  ) {}

  async dshBetaCommunityEntryState(signal?: AbortSignal): Promise<ArkmeDSHBetaCommunityEntryState> {
    const session = await this.runtime.requireSession()
    const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/community/dsh-beta/entry-state',
      {},
      session,
      signal,
    )
    const status = this.dshBetaCommunityStatus(data.status)
    const visible = booleanValue(data.visible)
    const groupTitle = stringValue(data.group_title).trim()
    const snapshot = objectValue(data.group_avatar_snapshot)
    const memberCount = Math.max(0, Math.trunc(numberValue(snapshot.member_count)))
    const memberIds = listValue(snapshot.members)
      .map(member => numberValue(objectValue(member).user_id))
      .filter(userId => Number.isSafeInteger(userId) && userId > 0)
      .slice(0, 5)
    let avatarRefs: string[] = []
    let groupAvatar: ArkmeGroupAvatarPresentation | undefined
    if (visible && status === 'ready' && memberIds.length > 0) {
      try {
        const profiles = await this.profile.publicProfileSummariesByUserIds(memberIds, session, signal)
          .catch(() => new Map())
        groupAvatar = await this.source.groupAvatarPresentation({
          memberCount,
          strategy: stringValue(snapshot.strategy).trim(),
          computedAtMillis: numberValue(snapshot.computed_at),
          memberIds,
        }, profiles, session.userId)
        avatarRefs = groupAvatar.slots.flatMap(slot => slot.avatarRef === undefined ? [] : [slot.avatarRef])
      } catch {
        // The optional entry must never degrade the normal conversation directory.
      }
    }
    return { status, visible, groupTitle, memberCount, avatarRefs, ...(groupAvatar === undefined ? {} : { groupAvatar }) }
  }

  async joinDSHBetaCommunity(signal?: AbortSignal): Promise<ArkmeDSHBetaCommunityJoinResult> {
    const session = await this.runtime.requireSession()
    const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/community/dsh-beta/join',
      {},
      session,
      signal,
    )
    const status = this.dshBetaCommunityStatus(data.status)
    const chatSessionUid = stringValue(data.chat_session_uid).trim()
    if ((status !== 'joined' && status !== 'already_member') || chatSessionUid === '') {
      throw new ArkmePluginError(
        'dsh-beta-community-contract-invalid',
        'DSH 内测群入群响应不完整',
        true,
        502,
      )
    }
    let groupTitle = stringValue(data.group_title).trim()
    if (groupTitle === '') {
      try {
        const detail = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
          '/api/v1/chats/detail',
          { chat_session_uid: chatSessionUid },
          session,
          signal,
        )
        const chatSession = objectValue(detail.session)
        if (stringValue(chatSession.chat_session_uid).trim() === chatSessionUid
          && numberValue(chatSession.session_kind) === 2) {
          groupTitle = stringValue(chatSession.title).trim()
        }
      } catch {
        // Membership is already committed; detail hydration must not make the join look failed.
      }
    }
    if (groupTitle === '') groupTitle = 'DSH 内测群'
    this.source.invalidateGroupAvatar(session.userId, chatSessionUid)
    const source: ArkmeSourceItem = {
      sourceRef: await this.source.sealSourceRef(session.userId, 'group_chat', chatSessionUid, groupTitle),
      sourceKey: await this.source.chatDirectorySourceKey(session.userId, chatSessionUid),
      kind: 'group_chat',
      displayName: groupTitle,
      activeAtMillis: 0,
      unreadCount: 0,
    }
    try {
      await this.source.hydrateSourceAvatars(
        [source],
        new Map(),
        new Map([[0, chatSessionUid]]),
        session,
        signal,
      )
    } catch {
      // Membership is committed by Chat; avatar decoration cannot turn it into a failed join.
    }
    this.source.setChatSourceByKey(`${String(session.userId)}:${chatSessionUid}`, source)
    this.source.invalidateSourceListCache(session.userId, 'root')
    return { status, source }
  }

  private dshBetaCommunityStatus(value: unknown): ArkmeDSHBetaCommunityStatus {
    if (value === 'ready' || value === 'already_member' || value === 'joined') return value
    throw new ArkmePluginError(
      'dsh-beta-community-contract-invalid',
      'DSH 内测群状态响应无效',
      true,
      502,
    )
  }
}
