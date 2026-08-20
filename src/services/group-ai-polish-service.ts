import { randomUUID } from 'node:crypto'
import type { ArkmeSessionCredentials } from '../keychain-store.js'
import type {
  ArkmeGroupAiPolishMutationResult,
  ArkmeGroupAiPolishNotice,
  ArkmeGroupAiPolishRuleCandidate,
  ArkmeGroupAiPolishSnapshot,
  ArkmeSourceItem,
  ArkmeSourceSendResult,
  ArkmeTimelineItem,
} from '../types.js'
import { ArkmePluginError, ServiceRuntime, objectValue, stringValue } from './service.js'
import { SourceService } from './source-service.js'

export interface ArkmeAiPolishConfigSnapshot {
  enabled: boolean
  canManage: boolean
  viewerRole: number
  activeRuleUid: string
  activeRuleName: string
  updatedAtMillis: number
  rules: Array<{
    ruleUid: string
    name: string
    ruleText: string
    ruleVersion: number
  }>
}

interface ArkmePendingAiPolishConfirmation {
  userId: number
  chatSessionUid: string
  groupName: string
  action: 'enable' | 'disable'
  expiresAtMillis: number
  candidateUid?: string
  ruleName?: string
  ruleText?: string
  promptVersion?: string
  extra?: Record<string, unknown>
}

interface ArkmePendingAiPolishRetry {
  userId: number
  sourceRef: string
  chatSessionUid: string
  relationUid: string
  recordUid: string
  originalText: string
  attempt: number
  expiresAtMillis: number
}

interface ArkmeAiPolishTextResult {
  taskUid: string
  attempt: number
  state: number
  action: number
  polishedText: string
  recordUid: string
  revisionUid: string
  ruleUid: string
  modelVersion: string
  promptVersion: string
  failureMessage: string
  extra: Record<string, unknown>
}

export interface ArkmeAiPolishChatPort {
  sendChatSourceTextRaw(
    sourceRef: string,
    chatSessionUid: string,
    text: string,
    recordUid: string,
    relationUid: string,
    session: ArkmeSessionCredentials,
    initialAiPolish?: Record<string, unknown>,
    contentPayload?: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { agentAuthored?: boolean },
  ): Promise<ArkmeSourceSendResult>
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanValue(value: unknown): boolean { return value === true }
function listValue(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

function compactAiPolishActorLabel(value: unknown): string {
  const normalized = stringValue(value).replace(/\s+/g, ' ').trim()
  if (normalized === '') return ''
  const characters = [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(normalized)]
    .map(segment => segment.segment)
  return characters.length <= 4 ? normalized : characters.slice(0, 4).join('') + '…'
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof ArkmePluginError) return error.message
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return '未知错误'
}

export class GroupAiPolishService {
  private readonly aiPolishConfirmations = new Map<string, ArkmePendingAiPolishConfirmation>()
  private readonly aiPolishRetries = new Map<string, ArkmePendingAiPolishRetry>()

  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly source: SourceService,
    private readonly chat: ArkmeAiPolishChatPort,
  ) {}

  dispose(): void {
    this.aiPolishConfirmations.clear()
    this.aiPolishRetries.clear()
  }

  private invalidateAiPolishReadCache(userId: number, chatSessionUid: string): void {
    const scope = this.runtime.requestScope(userId)
    this.runtime.requestCoordinator.invalidateKey(scope, 'ai-polish:settings:' + chatSessionUid)
    this.runtime.requestCoordinator.invalidateKey(scope, 'ai-polish:notices:' + chatSessionUid)
  }

  async inspectGroupAiPolish(
      sourceRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishSnapshot> {
      const session = await this.runtime.requireSession()
      const source = await this.source.openSourceRef(sourceRef, session.userId)
      if (source.kind !== 'group_chat') {
        throw new ArkmePluginError('group-ai-polish-source-invalid', 'AI 表达润色仅支持群聊', false)
      }
      const config = await this.queryGroupAiPolishConfig(source.ownerRef, session, options.signal)
      return this.groupAiPolishSnapshot(sourceRef, source.displayName, config)
    }
  
  async inspectGroupAiPolishByName(
      groupName: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishSnapshot> {
      const source = await this.resolveUniqueGroupByName(groupName, options.signal)
      return await this.inspectGroupAiPolish(source.sourceRef, options)
    }
  
  async readGroupAiPolishNotices(
      sourceRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishNotice[]> {
      const session = await this.runtime.requireSession()
      const source = await this.source.openSourceRef(sourceRef, session.userId)
      if (source.kind !== 'group_chat') {
        throw new ArkmePluginError('group-ai-polish-source-invalid', 'AI 表达润色通知仅支持群聊', false)
      }
      return await this.queryGroupAiPolishNotices(source.ownerRef, session, options.signal)
    }
  
  async generateGroupAiPolishRuleForSource(
      sourceRef: string,
      requirement: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishRuleCandidate> {
      const session = await this.runtime.requireSession()
      const source = await this.source.openSourceRef(sourceRef, session.userId)
      const instruction = requirement.trim()
      if (source.kind !== 'group_chat') {
        throw new ArkmePluginError('group-ai-polish-source-invalid', 'AI 表达润色仅支持群聊', false)
      }
      if (instruction === '' || [...instruction].length > 2_000) {
        throw new ArkmePluginError('group-ai-polish-requirement-invalid', '请提供不超过 2000 字的润色要求', false)
      }
      const config = await this.queryGroupAiPolishConfig(source.ownerRef, session, options.signal)
      if (!config.canManage) {
        throw new ArkmePluginError('group-ai-polish-forbidden', '当前无法确认有效群成员身份，请稍后重试', false, 403)
      }
      const generated = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/rules/generate',
        { chat_session_uid: source.ownerRef, instruction },
        session,
        options.signal,
      )
      const candidate = objectValue(generated.candidate ?? generated.rule ?? generated.generated_rule ?? generated)
      const ruleName = stringValue(candidate.name).trim()
      const ruleText = stringValue(candidate.rule_text).trim()
      if (ruleName === '' || ruleText === '') {
        throw new ArkmePluginError('group-ai-polish-generate-invalid', 'AI 没有生成可用的润色规则，请换一种描述重试', true, 502)
      }
      this.cleanupAiPolishState()
      const confirmationRef = `arkme-ai-polish-confirm-v1.${randomUUID()}`
      this.aiPolishConfirmations.set(confirmationRef, {
        userId: session.userId,
        chatSessionUid: source.ownerRef,
        groupName: source.displayName,
        action: 'enable',
        expiresAtMillis: Date.now() + 10 * 60_000,
        candidateUid: stringValue(candidate.candidate_uid).trim(),
        ruleName,
        ruleText,
        promptVersion: stringValue(candidate.prompt_version).trim(),
        extra: objectValue(candidate.extra),
      })
      return { groupName: source.displayName, ruleName, ruleText, confirmationRef }
    }
  
  async generateGroupAiPolishRule(
      groupName: string,
      requirement: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishRuleCandidate> {
      const source = await this.resolveUniqueGroupByName(groupName, options.signal)
      return await this.generateGroupAiPolishRuleForSource(source.sourceRef, requirement, options)
    }
  
  async confirmEnableGroupAiPolish(
      confirmationRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishMutationResult> {
      const session = await this.runtime.requireSession()
      const pending = this.requireAiPolishConfirmation(confirmationRef, session.userId, 'enable')
      const current = await this.queryGroupAiPolishConfig(pending.chatSessionUid, session, options.signal)
      if (!current.canManage) {
        throw new ArkmePluginError('group-ai-polish-forbidden', '当前无法确认有效群成员身份，请稍后重试', false, 403)
      }
      const updateAt = Date.now()
      const upserted = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/rules/upsert',
        {
          chat_session_uid: pending.chatSessionUid,
          ...(pending.candidateUid === undefined || pending.candidateUid === '' ? {} : { rule_uid: pending.candidateUid }),
          name: pending.ruleName,
          rule_text: pending.ruleText,
          ...(pending.promptVersion === undefined || pending.promptVersion === '' ? {} : { prompt_version: pending.promptVersion }),
          update_at: updateAt,
          ...(pending.extra === undefined || Object.keys(pending.extra).length === 0 ? {} : { extra: pending.extra }),
        },
        session,
        options.signal,
      )
      const rule = objectValue(upserted.rule ?? upserted)
      const ruleUid = stringValue(rule.rule_uid).trim()
      if (ruleUid === '') {
        throw new ArkmePluginError('group-ai-polish-rule-invalid', '保存润色规则后未返回有效规则', true, 502)
      }
      const updated = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/settings/update',
        {
          chat_session_uid: pending.chatSessionUid,
          enabled: true,
          active_rule_uid: ruleUid,
          update_at: Math.max(Date.now(), updateAt + 1),
        },
        session,
        options.signal,
      )
      const savedConfig = objectValue(updated.config ?? updated)
      if (!booleanValue(savedConfig.enabled) || stringValue(savedConfig.active_rule_uid).trim() !== ruleUid) {
        throw new ArkmePluginError('group-ai-polish-enable-invalid', '润色规则已保存，但开启状态确认失败，请重试', true, 502)
      }
      this.invalidateAiPolishReadCache(session.userId, pending.chatSessionUid)
      this.aiPolishConfirmations.delete(confirmationRef.trim())
      return { groupName: pending.groupName, enabled: true, ruleName: pending.ruleName ?? '', changed: true }
    }
  
  async prepareDisableGroupAiPolishForSource(
      sourceRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishRuleCandidate> {
      const session = await this.runtime.requireSession()
      const source = await this.source.openSourceRef(sourceRef, session.userId)
      if (source.kind !== 'group_chat') throw new ArkmePluginError('group-ai-polish-source-invalid', 'AI 表达润色仅支持群聊', false)
      const config = await this.queryGroupAiPolishConfig(source.ownerRef, session, options.signal)
      if (!config.canManage) throw new ArkmePluginError('group-ai-polish-forbidden', '当前无法确认有效群成员身份，请稍后重试', false, 403)
      this.cleanupAiPolishState()
      const confirmationRef = `arkme-ai-polish-confirm-v1.${randomUUID()}`
      this.aiPolishConfirmations.set(confirmationRef, {
        userId: session.userId, chatSessionUid: source.ownerRef, groupName: source.displayName,
        action: 'disable', expiresAtMillis: Date.now() + 10 * 60_000,
        ruleName: config.activeRuleName,
      })
      return {
        groupName: source.displayName,
        ruleName: config.activeRuleName,
        ruleText: '关闭后，新发送的群聊文本将不再自动润色。',
        confirmationRef,
      }
    }
  
  async prepareDisableGroupAiPolish(
      groupName: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishRuleCandidate> {
      const source = await this.resolveUniqueGroupByName(groupName, options.signal)
      return await this.prepareDisableGroupAiPolishForSource(source.sourceRef, options)
    }
  
  async confirmDisableGroupAiPolish(
      confirmationRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeGroupAiPolishMutationResult> {
      const session = await this.runtime.requireSession()
      const pending = this.requireAiPolishConfirmation(confirmationRef, session.userId, 'disable')
      const current = await this.queryGroupAiPolishConfig(pending.chatSessionUid, session, options.signal)
      if (!current.canManage) throw new ArkmePluginError('group-ai-polish-forbidden', '当前无法确认有效群成员身份，请稍后重试', false, 403)
      const updated = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/settings/update',
        { chat_session_uid: pending.chatSessionUid, enabled: false, active_rule_uid: '', update_at: Date.now() },
        session,
        options.signal,
      )
      if (booleanValue(objectValue(updated.config ?? updated).enabled)) {
        throw new ArkmePluginError('group-ai-polish-disable-invalid', '关闭 AI 表达润色失败，请重试', true, 502)
      }
      this.invalidateAiPolishReadCache(session.userId, pending.chatSessionUid)
      this.aiPolishConfirmations.delete(confirmationRef.trim())
      return { groupName: pending.groupName, enabled: false, ruleName: pending.ruleName ?? '', changed: current.enabled }
    }
  
  async retryGroupAiPolish(
      retryRef: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ArkmeSourceSendResult> {
      const session = await this.runtime.requireSession()
      this.cleanupAiPolishState()
      const normalized = retryRef.trim()
      const pending = this.aiPolishRetries.get(normalized)
      if (pending === undefined || pending.userId !== session.userId || pending.expiresAtMillis <= Date.now()) {
        this.aiPolishRetries.delete(normalized)
        throw new ArkmePluginError('group-ai-polish-retry-expired', '本次润色重试已失效，请重新发送消息', false, 410)
      }
      const taskUid = randomUUID()
      const attempt = pending.attempt + 1
      const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/text/retry-apply',
        {
          task_uid: taskUid,
          chat_session_uid: pending.chatSessionUid,
          rel_uid: pending.relationUid,
          record_uid: pending.recordUid,
          attempt,
          original_text: pending.originalText,
          extra: { input_source: 'dsh_plugin', content_kind: 'plain_text' },
        },
        session,
        options.signal,
      )
      const result = this.aiPolishTextResult(data)
      if (result.state === 1 && result.action === 1 && result.polishedText !== '') {
        this.aiPolishRetries.delete(normalized)
        return {
          sourceRef: pending.sourceRef,
          itemUid: result.recordUid || pending.recordUid,
          status: 1,
          localState: 'synced',
          aiPolish: {
            state: 'polished', originalText: pending.originalText, polishedText: result.polishedText,
          },
        }
      }
      pending.attempt = attempt
      pending.expiresAtMillis = Date.now() + 30 * 60_000
      return {
        sourceRef: pending.sourceRef,
        itemUid: pending.recordUid,
        status: 1,
        localState: 'synced',
        aiPolish: {
          state: 'failed', originalText: pending.originalText,
          failureMessage: result.failureMessage || '润色失败', retryRef: normalized,
        },
      }
    }
  
  async sendGroupSourceTextWithAiPolish(
      sourceRef: string,
      chatSessionUid: string,
      originalText: string,
      recordUid: string,
      relationUid: string,
      session: ArkmeSessionCredentials,
      options: { agentAuthored?: boolean; signal?: AbortSignal } = {},
    ): Promise<ArkmeSourceSendResult> {
      let config: ArkmeAiPolishConfigSnapshot
      try {
        config = await this.queryGroupAiPolishConfig(chatSessionUid, session, options.signal)
      } catch {
        return await this.chat.sendChatSourceTextRaw(
          sourceRef, chatSessionUid, originalText, recordUid, relationUid, session, undefined, undefined, options.signal, options,
        )
      }
      if (!config.enabled || config.activeRuleUid === '') {
        return await this.chat.sendChatSourceTextRaw(
          sourceRef, chatSessionUid, originalText, recordUid, relationUid, session, undefined, undefined, options.signal, options,
        )
      }
      const taskUid = randomUUID()
      let polished: ArkmeAiPolishTextResult
      try {
        const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
          '/api/v1/chats/ai-polish/text/polish',
          {
            task_uid: taskUid,
            chat_session_uid: chatSessionUid,
            attempt: 1,
            original_text: originalText,
            extra: { input_source: 'dsh_plugin', content_kind: 'plain_text' },
          },
          session,
          options.signal,
        )
        polished = this.aiPolishTextResult(data)
      } catch (error) {
        const sent = await this.chat.sendChatSourceTextRaw(
          sourceRef, chatSessionUid, originalText, recordUid, relationUid, session, undefined, undefined, options.signal, options,
        )
        return this.withFailedAiPolishRetry(
          sent, sourceRef, chatSessionUid, relationUid, recordUid, originalText, 1, session.userId,
          safeFailureMessage(error),
        )
      }
      if (polished.state === 1 && polished.action === 1 && polished.polishedText !== '') {
        const activeRule = config.rules.find(rule => rule.ruleUid === polished.ruleUid)
        const sent = await this.chat.sendChatSourceTextRaw(
          sourceRef,
          chatSessionUid,
          originalText,
          recordUid,
          relationUid,
          session,
          {
            revision_uid: polished.revisionUid,
            attempt_uid: polished.taskUid || taskUid,
            original_text: originalText,
            polished_text: polished.polishedText,
            rule_uid: polished.ruleUid,
            rule_name: activeRule?.name ?? config.activeRuleName,
            model: polished.modelVersion,
            prompt: polished.promptVersion,
            ...(Object.keys(polished.extra).length === 0 ? {} : { extra: polished.extra }),
          },
          undefined,
          options.signal,
          options,
        )
        return {
          ...sent,
          aiPolish: { state: 'polished', originalText, polishedText: polished.polishedText },
        }
      }
      const sent = await this.chat.sendChatSourceTextRaw(
        sourceRef, chatSessionUid, originalText, recordUid, relationUid, session, undefined, undefined, options.signal, options,
      )
      if (polished.action === 2) {
        return { ...sent, aiPolish: { state: 'kept_original', originalText } }
      }
      return this.withFailedAiPolishRetry(
        sent, sourceRef, chatSessionUid, relationUid, recordUid, originalText,
        Math.max(1, polished.attempt), session.userId, polished.failureMessage || '润色失败',
      )
    }
  
  private withFailedAiPolishRetry(
      sent: ArkmeSourceSendResult,
      sourceRef: string,
      chatSessionUid: string,
      relationUid: string,
      recordUid: string,
      originalText: string,
      attempt: number,
      userId: number,
      failureMessage: string,
    ): ArkmeSourceSendResult {
      this.cleanupAiPolishState()
      const retryRef = `arkme-ai-polish-retry-v1.${randomUUID()}`
      this.aiPolishRetries.set(retryRef, {
        userId, sourceRef, chatSessionUid, relationUid, recordUid, originalText, attempt,
        expiresAtMillis: Date.now() + 30 * 60_000,
      })
      return {
        ...sent,
        aiPolish: { state: 'failed', originalText, failureMessage, retryRef },
      }
    }
  
  timelineAiPolish(
      record: Record<string, unknown>,
      payload: Record<string, unknown>,
    ): ArkmeTimelineItem['aiPolish'] | undefined {
      const preview = objectValue(
        payload.ai_polish_preview ?? payload.aiPolishPreview
        ?? record.ai_polish_preview ?? record.aiPolishPreview,
      )
      const originalText = stringValue(preview.original_text ?? preview.originalText)
      const polishedText = stringValue(preview.polished_text ?? preview.polishedText)
      const hasPolish = booleanValue(
        payload.has_polish ?? payload.hasPolish ?? record.has_polish ?? record.hasPolish,
      ) || (originalText !== '' && polishedText !== '')
      if (!hasPolish || originalText === '' || polishedText === '') return undefined
      return { state: 'polished', originalText, polishedText }
    }
  
  async queryGroupAiPolishConfig(
      chatSessionUid: string,
      session: ArkmeSessionCredentials,
      signal?: AbortSignal,
    ): Promise<ArkmeAiPolishConfigSnapshot> {
      const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/settings/query',
        { chat_session_uid: chatSessionUid },
        session,
        signal,
        {
          lane: 'background-read',
          key: `ai-polish:settings:${chatSessionUid}`,
          cacheMs: 15_000,
          failureCooldownMs: 5_000,
        },
      )
      const config = objectValue(data.config ?? data.setting ?? data.settings ?? data)
      const activeRuleUid = stringValue(config.active_rule_uid).trim()
      const rules = listValue(data.rules).map(raw => objectValue(raw)).map(rule => ({
        ruleUid: stringValue(rule.rule_uid).trim(),
        name: stringValue(rule.name).trim() || '未命名规则',
        ruleText: stringValue(rule.rule_text).trim(),
        ruleVersion: numberValue(rule.rule_version),
      })).filter(rule => rule.ruleUid !== '' && rule.ruleText !== '')
      return {
        enabled: booleanValue(config.enabled ?? config.is_enabled),
        canManage: booleanValue(data.can_manage),
        viewerRole: numberValue(data.viewer_role),
        activeRuleUid,
        activeRuleName: rules.find(rule => rule.ruleUid === activeRuleUid)?.name ?? '',
        updatedAtMillis: numberValue(config.update_at),
        rules,
      }
    }
  
  groupAiPolishSnapshot(
      sourceRef: string,
      groupName: string,
      config: ArkmeAiPolishConfigSnapshot,
    ): ArkmeGroupAiPolishSnapshot {
      return {
        sourceRef,
        groupName,
        enabled: config.enabled,
        canManage: config.canManage,
        viewerRole: config.viewerRole,
        activeRuleName: config.activeRuleName,
        rules: config.rules.map(rule => ({
          ruleRef: rule.ruleUid,
          name: rule.name,
          ruleText: rule.ruleText,
          isActive: rule.ruleUid === config.activeRuleUid,
        })),
        updatedAtMillis: config.updatedAtMillis,
      }
    }
  
  async queryGroupAiPolishNotices(
      chatSessionUid: string,
      session: ArkmeSessionCredentials,
      signal?: AbortSignal,
    ): Promise<ArkmeGroupAiPolishNotice[]> {
      const data = await this.runtime.authenticatedChatPost<Record<string, unknown>>(
        '/api/v1/chats/ai-polish/notices/query',
        { chat_session_uid: chatSessionUid, limit: 100 },
        session,
        signal,
        {
          lane: 'background-read',
          key: `ai-polish:notices:${chatSessionUid}`,
          cacheMs: 15_000,
          failureCooldownMs: 5_000,
        },
      )
      return listValue(data.notices).map(raw => objectValue(raw)).map(notice => {
        const kind = numberValue(notice.notice_kind)
        const rule = stringValue(notice.rule_name).trim() || stringValue(notice.rule_text).trim()
        const actor = compactAiPolishActorLabel(notice.actor_display_name_snapshot)
        return {
          noticeUid: stringValue(notice.notice_uid).trim(),
          sourceKey: stringValue(notice.source_key).trim(),
          message: kind === 1
            ? actor === '' ? `AI润色已开启：${rule}` : `${actor}开启了 AI 润色：${rule}`
            : kind === 2
              ? actor === '' ? `AI润色规则已修改：${rule}` : `${actor}修改了 AI 润色规则：${rule}`
              : '',
          createdAtMillis: numberValue(notice.created_at),
          status: numberValue(notice.status),
        }
      }).filter(notice => notice.noticeUid !== '' && notice.message !== '' && notice.createdAtMillis > 0
        && (notice.status === 0 || notice.status === 1))
        .map(({ status: _status, ...notice }) => notice)
    }
  
  private async resolveUniqueGroupByName(
      groupName: string,
      signal?: AbortSignal,
    ): Promise<ArkmeSourceItem> {
      const normalized = groupName.trim()
      if (normalized === '') throw new ArkmePluginError('group-name-required', '请提供准确的群名称', false)
      const matches = new Map<string, ArkmeSourceItem>()
      let cursor: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await this.source.listSources('root', {
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
          ...(signal === undefined ? {} : { signal }),
        })
        for (const item of result.items) {
          if (item.kind === 'group_chat' && item.displayName.trim() === normalized) matches.set(item.sourceRef, item)
        }
        if (!result.hasMore || result.nextCursor === undefined) break
        cursor = result.nextCursor
      }
      if (matches.size === 0) {
        throw new ArkmePluginError('group-name-not-found', `没有找到名称为“${normalized}”的群聊，请核对完整群名`, false, 404)
      }
      if (matches.size > 1) {
        throw new ArkmePluginError('group-name-ambiguous', `找到 ${String(matches.size)} 个同名群“${normalized}”，请先在插件界面打开目标群后设置`, false, 409)
      }
      return [...matches.values()][0]!
    }
  
  private requireAiPolishConfirmation(
      confirmationRef: string,
      userId: number,
      action: 'enable' | 'disable',
    ): ArkmePendingAiPolishConfirmation {
      this.cleanupAiPolishState()
      const normalized = confirmationRef.trim()
      const pending = this.aiPolishConfirmations.get(normalized)
      if (pending === undefined || pending.userId !== userId || pending.action !== action
        || pending.expiresAtMillis <= Date.now()) {
        this.aiPolishConfirmations.delete(normalized)
        throw new ArkmePluginError('group-ai-polish-confirmation-invalid', '确认已失效，请重新生成或读取一次设置', false, 410)
      }
      return pending
    }
  
  private cleanupAiPolishState(): void {
      const now = Date.now()
      for (const [key, value] of this.aiPolishConfirmations) {
        if (value.expiresAtMillis <= now) this.aiPolishConfirmations.delete(key)
      }
      for (const [key, value] of this.aiPolishRetries) {
        if (value.expiresAtMillis <= now) this.aiPolishRetries.delete(key)
      }
    }
  
  private aiPolishTextResult(data: Record<string, unknown>): ArkmeAiPolishTextResult {
      return {
        taskUid: stringValue(data.task_uid).trim(),
        attempt: numberValue(data.attempt),
        state: numberValue(data.state),
        action: numberValue(data.action),
        polishedText: stringValue(data.polished_text),
        recordUid: stringValue(data.record_uid ?? data.recordUid).trim(),
        revisionUid: stringValue(data.revision_uid ?? data.revisionUid).trim(),
        ruleUid: stringValue(data.rule_uid).trim(),
        modelVersion: stringValue(data.model_version).trim(),
        promptVersion: stringValue(data.prompt_version).trim(),
        failureMessage: stringValue(data.failure_message).trim(),
        extra: objectValue(data.extra),
      }
    }
}
