import type { ArkmeRecordDeletionResult } from '../record-deletion-contract.js'
import { callArkme } from './api.js'
import { arkmeUi } from './ui-controller.js'
export interface RecordDeletionClientPort {
  delete(sourceRef: string, deletionRefs: readonly string[], signal: AbortSignal): Promise<ArkmeRecordDeletionResult>
}
export const recordDeletionClientPort: RecordDeletionClientPort = {
  async delete(sourceRef, deletionRefs, signal) {
    const deadline = AbortSignal.timeout(30_000)
    try { return await callArkme<ArkmeRecordDeletionResult>('source.record-delete', { sourceRef, deletionRefs }, AbortSignal.any([signal, deadline])) }
    catch (error) {
      if (deadline.aborted && !signal.aborted) throw new Error('删除请求超时，请刷新核对后再操作')
      throw error
    } finally {
      // A lost response may still have changed owner facts. Invalidate readers; never replay a write.
      arkmeUi.recordChanged()
      arkmeUi.chatChanged()
    }
  },
}
