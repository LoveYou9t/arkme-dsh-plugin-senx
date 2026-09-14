import type { ArkmeSessionCredentials } from '../keychain-store.js'
import type { ArkmeRecordDeletionItem, ArkmeRecordDeletionResult } from '../record-deletion-contract.js'
import { openRecordDeletionRef } from '../record-deletion-ref.js'
import { ArkmePluginError, ServiceRuntime, objectValue } from './service.js'
import type { SourceService } from './source-service.js'

/** User Record owner operation. No Agent authorization, Chat withdrawal or permanent-delete fallback. */
export interface RecordDeletionPort {
  deleteBatch(items: readonly ArkmeRecordDeletionItem[], session: ArkmeSessionCredentials, signal?: AbortSignal): Promise<ArkmeRecordDeletionResult>
}
export class RecordDeletionHttpPort implements RecordDeletionPort {
  constructor(private readonly runtime: ServiceRuntime) {}
  async deleteBatch(items: readonly ArkmeRecordDeletionItem[], session: ArkmeSessionCredentials, signal?: AbortSignal): Promise<ArkmeRecordDeletionResult> {
    const raw = objectValue(await this.runtime.authenticatedPost<unknown>('/api/v1/records/delete-batch', {
      items: items.map(item => ({ record_uid: item.recordUid, expected_version: item.version })),
    }, session, signal, { trackWriteOutcome: true }))
    const results = Array.isArray(raw.items) ? raw.items.map(objectValue) : []
    const byUid = new Map(results.map(item => [item.record_uid, item]))
    if (typeof raw.projection_refresh_pending !== 'boolean' || results.length !== items.length || byUid.size !== items.length
      || items.some(item => {
        const result = byUid.get(item.recordUid)
        return !result || !['deleted', 'already_deleted', 'conflict', 'unknown'].includes(String(result.result))
          || !Number.isSafeInteger(result.version) || Number(result.version) <= 0
          || (result.result === 'deleted' && Number(result.version) <= item.version)
      })) throw new ArkmePluginError('record-delete-result-unknown', '删除结果暂时无法确认，请刷新核对后再操作', false, 502, { writeOutcomeUnknown: true })
    return { items: items.map(item => {
      const result = byUid.get(item.recordUid)!
      return { recordUid: item.recordUid, version: Number(result.version), result: result.result as ArkmeRecordDeletionResult['items'][number]['result'] }
    }), projectionRefreshPending: raw.projection_refresh_pending }
  }
}
export class RecordDeletionService {
  constructor(private readonly runtime: ServiceRuntime, private readonly sources: SourceService, private readonly port: RecordDeletionPort = new RecordDeletionHttpPort(runtime)) {}
  async delete(sourceRef: string, deletionRefs: readonly string[], signal?: AbortSignal): Promise<ArkmeRecordDeletionResult> {
    const invalid = () => new ArkmePluginError('record-delete-selection-invalid', '请选择 1 至 100 条当前页面内可删除的本人快记', false, 409)
    if (!Array.isArray(deletionRefs) || deletionRefs.length < 1 || deletionRefs.length > 100) throw invalid()
    const session = await this.runtime.requireSession()
    const source = await this.sources.openSourceRef(sourceRef, session.userId)
    const key = await this.runtime.stateStore.uniqueCode()
    const refs = deletionRefs.map(ref => openRecordDeletionRef(ref, key))
    const seen = new Set<string>()
    for (const ref of refs) {
      if (ref.userId !== session.userId || ref.sourceKind !== source.kind || ref.sourceOwnerRef !== source.ownerRef || seen.has(ref.recordUid)) throw invalid()
      seen.add(ref.recordUid)
    }
    if ((await this.runtime.requireSession()).userId !== session.userId) throw new ArkmePluginError('account-changed', '账号已切换，请重新选择', false, 409)
    if (signal?.aborted) throw signal.reason ?? new Error('请求已取消')
    try { return await this.port.deleteBatch(refs.map(ref => ({ recordUid: ref.recordUid, version: ref.recordVersion })), session, signal) }
    finally {
      this.sources.invalidateSourceListCache(session.userId)
      this.runtime.invalidateKey(this.runtime.requestScope(session.userId), 'calendar:')
    }
  }
}
