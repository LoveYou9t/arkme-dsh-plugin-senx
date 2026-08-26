import type { ArkmeRichSendInput, ArkmeSourceSendResult, ArkmeUploadedAsset } from './types.js'
export const ARKME_TOOL_FILE_MAX_BYTES = 64 * 1024

export interface ArkmeFilePolicy {
  version: 1
  maxFileBytes: number
  maxImageBytes: number
  maxAttachments: number
}

export interface ArkmeLocalFile {
  fileRef: string
  fileName: string
  mimeType: string
  size: number
  fileKind: 1 | 2 | 3 | 4
}

export interface ArkmeFileProgress {
  phase: 'preparing' | 'uploading' | 'completing' | 'ready'
  sentBytes: number
  totalBytes: number
}

export interface ArkmeFileSendInput {
  sourceRef: string
  recordUid: string
  relationUid: string
  fileRefs: string[]
  content: Omit<ArkmeRichSendInput, 'assets'>
}

export interface ArkmeFileSendTask extends ArkmeFileSendInput {
  taskRef: string
  createdAtMillis: number
  state: 'queued' | 'uploading' | 'sending' | 'sent' | 'failed' | 'uncertain'
  files: Array<ArkmeLocalFile & { progress: ArkmeFileProgress; asset?: ArkmeUploadedAsset }>
  result?: ArkmeSourceSendResult
  error?: string
}

export interface ArkmeFileReception {
  state: 'missing' | 'receiving' | 'ready' | 'failed'
  receivedBytes: number
  totalBytes: number
  file?: ArkmeLocalFile
  error?: string
}

export function arkmeVisibleUploadFraction(progress: ArkmeFileProgress): number {
  if (progress.phase === 'ready') return 1
  return Math.min(.99, Math.max(0, progress.totalBytes > 0 ? progress.sentBytes / progress.totalBytes : 0))
}

/** Picked audio is a file, not a recorded voice message. */
export function arkmePickedFileKind(mimeType: string): ArkmeLocalFile['fileKind'] {
  return mimeType.startsWith('image/') ? 1 : mimeType.startsWith('video/') ? 3 : 4
}
