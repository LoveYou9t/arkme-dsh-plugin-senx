import type {
  ArkmeGroupActionResult,
  ArkmeGroupMemberItem,
  ArkmeGroupMemberList,
  ArkmeGroupMemberRole,
  ArkmeGroupMemberStatus,
  ArkmeGroupNotificationResult,
  ArkmeGroupSettingsSnapshot,
  ArkmeSourceItem,
} from '../types.js'
import { ProfileService } from './profile-service.js'
import { SourceService } from './source-service.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function booleanValue(value: unknown): boolean { return value === true }
function listValue(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

function chatMessageDnd(value: unknown): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const policy = value as Record<string, unknown>
  return numberValue(policy.mute_state) === 2 || numberValue(policy.notify_state) === 2
}

function chatMemberRole(value: unknown): ArkmeGroupMemberRole {
  if (value === 'owner' || value === 1) return 'owner'
  if (value === 'admin' || value === 2) return 'admin'
  if (value === 'member' || value === 'participant' || value === 3) return 'member'
  return 'unknown'
}

function chatMemberStatus(value: unknown): ArkmeGroupMemberStatus {
  if (value === 'active' || value === 1) return 'active'
  if (value === 'left' || value === 2) return 'left'
  if (value === 'removed' || value === 3) return 'removed'
  return 'unknown'
}

export class GroupService {
  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
    private readonly profile: ProfileService,
  ) {}

  async listGroupMembers(
    sourceRef: string,
    options: { activeOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<ArkmeGroupMemberList> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持查看群聊成员', false)
    }
    const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/members/list',
      { chat_session_uid: source.ownerRef, active_only: options.activeOnly !== false },
      session,
      options.signal,
    )
    const rawItems = listValue(data.items).map(objectValue)
    const userIds = rawItems
      .map(item => numberValue(item.user_id))
      .filter(userId => Number.isSafeInteger(userId) && userId > 0)
    const profiles = await this.profile.publicProfileSummariesByUserIds(userIds, session, options.signal).catch(() => new Map())
    const members: ArkmeGroupMemberItem[] = []
    for (const item of rawItems) {
      const userId = numberValue(item.user_id)
      if (!Number.isSafeInteger(userId) || userId <= 0) continue
      const profile = profiles.get(userId)
      const remarkName = stringValue(item.remark).trim()
      const memberName = stringValue(item.display_name_snapshot).trim()
      const profileDisplayName = profile?.displayName.trim() ?? ''
      const publicDisplayName = profileDisplayName === `用户 ${String(userId)}` ? '' : profileDisplayName
      const displayName = [remarkName, memberName, publicDisplayName]
        .find(value => value !== '' && value !== '成员' && value !== '群成员')
        ?? '群成员'
      const secondaryName = [memberName, publicDisplayName, remarkName]
        .find(value => value !== '' && value !== '成员' && value !== '群成员' && value !== displayName)
        ?? ''
      const role = chatMemberRole(item.role)
      const status = chatMemberStatus(item.status)
      members.push({
        userId,
        displayName,
        ...(memberName === '' ? {} : { memberName }),
        ...(secondaryName === '' ? {} : { secondaryName }),
        ...(profile?.avatarUrl === undefined ? {} : { avatarRef: await this.profile.sealProfileImageRef(session.userId, userId) }),
        role,
        status,
        isSelf: userId === session.userId,
        isOwner: role === 'owner',
        joinedAtMillis: numberValue(item.join_at),
      })
    }
    const roleRank = (role: ArkmeGroupMemberRole) => role === 'owner' ? 0 : role === 'admin' ? 1 : role === 'member' ? 2 : 3
    members.sort((left, right) => roleRank(left.role) - roleRank(right.role)
      || (right.status === 'active' ? 1 : 0) - (left.status === 'active' ? 1 : 0)
      || left.joinedAtMillis - right.joinedAtMillis
      || left.userId - right.userId)
    const self = members.find(item => item.isSelf)
    const resultSource = await this.source.sourceItem(source)
    this.source.setChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`, resultSource)
    return {
      source: resultSource,
      items: members,
      total: members.length,
      activeCount: members.filter(item => item.status === 'active').length,
      selfRole: self?.role ?? 'unknown',
      selfStatus: self?.status ?? 'unknown',
    }
  }

  async groupSettings(sourceRef: string, signal?: AbortSignal): Promise<ArkmeGroupSettingsSnapshot> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持查看群聊设置', false)
    }
    const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/detail',
      { chat_session_uid: source.ownerRef },
      session,
      signal,
    )
    const chatSession = objectValue(data.session)
    const currentMember = objectValue(data.current_member)
    const title = stringValue(chatSession.title).trim() || source.displayName
    const messageDnd = chatMessageDnd(data.current_policy) ?? false
    const nextSource: ArkmeSourceItem = {
      sourceRef: await this.source.sealSourceRef(session.userId, 'group_chat', source.ownerRef, title),
      sourceKey: await this.source.chatDirectorySourceKey(session.userId, source.ownerRef),
      kind: 'group_chat',
      displayName: title,
      activeAtMillis: numberValue(chatSession.last_active_at),
      unreadCount: numberValue(objectValue(data.unread_snapshot).unread_count),
      isMuted: messageDnd,
      ...((numberValue(chatSession.last_seq)) > 0 ? { latestSequence: numberValue(chatSession.last_seq) } : {}),
    }
    try {
      await this.source.hydrateSourceAvatars([nextSource], new Map(), new Map([[0, source.ownerRef]]), session, signal)
    } catch {
      // Settings must remain readable if group-avatar decoration is temporarily unavailable.
    }
    this.source.setChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`, nextSource)
    const selfRole = chatMemberRole(currentMember.role)
    const selfStatus = chatMemberStatus(currentMember.status)
    const active = selfStatus === 'active'
    return {
      source: nextSource,
      selfRole,
      selfStatus,
      canRename: active && selfRole === 'owner',
      canDissolve: active && selfRole === 'owner',
      canLeave: active && selfRole !== 'owner',
      messageDnd,
    }
  }

  async setGroupMessageDnd(
    sourceRef: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<ArkmeGroupNotificationResult> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持设置群聊消息免打扰', false)
    }
    const current = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/policy/get',
      { chat_session_uid: source.ownerRef },
      session,
      signal,
    )
    await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/policy/update',
      {
        chat_session_uid: source.ownerRef,
        show_in_home_state: numberValue(current.show_in_home_state) || 1,
        privacy_state: numberValue(current.privacy_state) || 1,
        mute_state: enabled ? 2 : 1,
        pin_state: numberValue(current.pin_state) || 1,
        notify_state: enabled ? 2 : 1,
        status: numberValue(current.status) || 1,
        update_at: Date.now(),
      },
      session,
      signal,
    )
    const cacheKey = `${String(session.userId)}:${source.ownerRef}`
    const cached = this.source.cachedChatSourceByKey(cacheKey)
    if (cached !== undefined) this.source.setChatSourceByKey(cacheKey, { ...cached, isMuted: enabled })
    return {
      messageDnd: enabled,
    }
  }

  async renameGroup(sourceRef: string, title: string, signal?: AbortSignal): Promise<ArkmeGroupActionResult> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    const normalizedTitle = title.trim()
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持重命名群聊', false)
    }
    if (normalizedTitle === '' || normalizedTitle.length > 80) {
      throw new ArkmePluginError('group-title-invalid', '群聊名称需为 1-80 个字符', false)
    }
    const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/rename',
      { chat_session_uid: source.ownerRef, title: normalizedTitle, update_at: Date.now() },
      session,
      signal,
    )
    const nextSource = await this.source.chatSourceFromBundle(data, session, this.source.cachedChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`), [])
    try {
      await this.source.hydrateSourceAvatars([nextSource], new Map(), new Map([[0, source.ownerRef]]), session, signal)
    } catch {
      // Rename success is authoritative; avatar refresh is optional.
    }
    this.source.setChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`, nextSource)
    return { source: nextSource, status: 'ok' }
  }

  async leaveGroup(sourceRef: string, signal?: AbortSignal): Promise<ArkmeGroupActionResult> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持退出群聊', false)
    }
    await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/members/update',
      { chat_session_uid: source.ownerRef, target_user_id: session.userId, action: 1 },
      session,
      signal,
    )
    const nextSource = await this.source.sourceItem(source)
    this.source.setChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`, nextSource)
    return { source: nextSource, status: 'ok' }
  }

  async dissolveGroup(sourceRef: string, signal?: AbortSignal): Promise<ArkmeGroupActionResult> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持解散群聊', false)
    }
    await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/dissolve',
      { chat_session_uid: source.ownerRef, update_at: Date.now() },
      session,
      signal,
    )
    const nextSource = await this.source.sourceItem(source)
    this.source.setChatSourceByKey(`${String(session.userId)}:${source.ownerRef}`, nextSource)
    return { source: nextSource, status: 'ok' }
  }

  async reportGroup(sourceRef: string, reason: string, signal?: AbortSignal): Promise<ArkmeGroupActionResult> {
    const session = await this.runtime.requireSession()
    const source = await this.source.openSourceRef(sourceRef, session.userId)
    if (source.kind !== 'group_chat') {
      throw new ArkmePluginError('group-source-invalid', '仅支持举报群聊', false)
    }
    await this.runtime.authenticatedChatPost<Record<string, unknown>>(
      '/api/v1/chats/report',
      {
        chat_session_uid: source.ownerRef,
        report_type: 2,
        reason: reason.trim().slice(0, 200),
        created_at: Date.now(),
      },
      session,
      signal,
    )
    return { source: await this.source.sourceItem(source), status: 'ok' }
  }
}
