import type { ArkmeAuthSnapshot, ArkmeRecordingSpeakerMutationResult, ArkmeRecordingSpeakerOption } from '../../types.js'
import { callArkme } from '../api.js'
import { arkmeAuthStore } from '../auth-store.js'
import { ResourceStore, resourceCancelled } from '../resource-store.js'

export function recordingSpeakerAccount(auth: ArkmeAuthSnapshot | undefined): string | undefined {
  return auth?.status === 'authenticated' && auth.userId !== undefined
    ? `${auth.environment}:${auth.userId}` : undefined
}

export interface RecordingSpeakerOptionsBinding { account: string | undefined; itemRef: string }

// Recommendation and assignment belong to the exact signed item context, not to a display name.
export const recordingSpeakerOptions = new ResourceStore<ArkmeRecordingSpeakerOption[], RecordingSpeakerOptionsBinding>({
  load: async (binding, signal) => {
    const current = () => binding.account !== undefined
      && binding.account === recordingSpeakerAccount(arkmeAuthStore.getSnapshot().auth) && !signal.aborted
    if (!current()) throw resourceCancelled()
    const options = await callArkme<ArkmeRecordingSpeakerOption[]>(
      'recordings.speaker.options', { itemRef: binding.itemRef }, signal,
    )
    if (!current()) throw resourceCancelled()
    return options
  },
}, Date.now, 50)

let account = recordingSpeakerAccount(arkmeAuthStore.getSnapshot().auth)
arkmeAuthStore.subscribe(() => {
  const next = recordingSpeakerAccount(arkmeAuthStore.getSnapshot().auth)
  if (account === next) return
  account = next
  recordingSpeakerOptions.reset()
  recordingSpeakerOptions.invalidate()
})

export async function assignRecordingSpeaker(
  key: string,
  binding: RecordingSpeakerOptionsBinding,
  input: { scope: 'item' | 'speaker'; speakerRef?: string; newSpeakerName?: string },
): Promise<ArkmeRecordingSpeakerMutationResult | undefined> {
  return await recordingSpeakerOptions.mutate(key, binding, async context => {
    try {
      if (binding.account === undefined || binding.account !== recordingSpeakerAccount(arkmeAuthStore.getSnapshot().auth)) throw resourceCancelled()
      const value = await callArkme<ArkmeRecordingSpeakerMutationResult>(
        'recordings.speaker.assign-item', { itemRef: binding.itemRef, ...input }, context.signal,
      )
      if (!context.current()) return undefined
      return value
    } catch (error) {
      if (!context.current()) return undefined
      throw error
    } finally {
      if (context.current()) {
        // A failed command may already have created a speaker. Reconcile reads; never retry the write.
        recordingSpeakerOptions.reset(candidateKey => candidateKey === key || !recordingSpeakerOptions.get(candidateKey).mutating)
        recordingSpeakerOptions.invalidate()
      }
    }
  })
}
