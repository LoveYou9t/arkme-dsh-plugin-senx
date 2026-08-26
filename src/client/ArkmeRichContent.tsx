import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArkmeFileIcon } from './ArkmeFileIcon.js'
import { arkmeTheme } from './arkme-theme.js'
import { ARKME_DEFAULT_SHARE_WEBSITE } from '../types.js'
import type { ArkmeContentBlock, ArkmeLinkMetadata, ArkmeLongArticleDetail, ArkmeTimelineItem, ArkmeUploadedAsset } from '../types.js'
import { callArkme } from './api.js'
import { ArkmeLongArticleDialog } from './ArkmeLongArticleDialog.js'
import { arkmeEmojiTextRuns } from './arkme-emoji.js'
import { ArkmeVoiceContent, arkmeVoiceMediaUrl } from './ArkmeVoiceContent.js'
import { ArkmeFileViewer, ArkmeFileActions, arkmeLocalFileUrl, arkmeFileSize, useArkmeOriginal } from './ArkmeFileViewer.js'
import { arkmeVisibleUploadFraction } from '../file-transfer-contract.js'

const mediaRoute = '/arkme-self/api/media'
const textCollapseCharacterThreshold = 300
const textCollapseNewlineThreshold = 5
const textCollapseMaxLines = 5
const mediaGap = 5

const styles: Record<string, CSSProperties> = {
  stack: { width: 'max-content', maxWidth: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
  text: { width: 'max-content', maxWidth: '100%', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.62 },
  emojiInline: { display: 'inline-block', width: 22, height: 22, objectFit: 'contain', verticalAlign: '-6px' },
  collapsedText: { display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: textCollapseMaxLines },
  textFrame: { position: 'relative', width: '100%', maxWidth: '100%' },
  textFade: { position: 'absolute', right: 0, bottom: 22, left: 0, height: 28, pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0), var(--arkme-bubble-fade, rgba(238,243,255,.96)))' },
  collapseToggle: { display: 'block', marginLeft: 'auto', border: 0, padding: '2px 0', background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #9097a1)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: '18px' },
  mediaGrid: { display: 'grid', gap: mediaGap, maxWidth: '100%' },
  mediaTile: { position: 'relative', display: 'block', width: '100%', aspectRatio: '1', overflow: 'hidden', border: 0, padding: 0, borderRadius: 8, background: 'rgba(127,127,127,.10)', cursor: 'pointer' },
  mediaImage: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
  sticker: { display: 'block', width: 148, maxWidth: '42vw', height: 148, maxHeight: '24vh', objectFit: 'contain', cursor: 'pointer' },
  videoPreview: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', background: '#111', pointerEvents: 'none' },
  videoBadge: { position: 'absolute', left: 6, bottom: 6, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 5px', borderRadius: 6, background: 'rgba(0,0,0,.62)', color: '#fff', fontSize: 10, lineHeight: '14px' },
  file: { width: 220, maxWidth: '100%', height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', boxSizing: 'border-box', borderRadius: 8, color: 'inherit', background: 'transparent', textDecoration: 'none' },
  fileIconBox: { width: 40, height: 40, flex: 'none', display: 'grid', placeItems: 'center' },
  fileName: { minWidth: 0, display: '-webkit-box', overflow: 'hidden', overflowWrap: 'anywhere', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, fontSize: 12, lineHeight: '18px' },
  article: { width: 400, maxWidth: '100%', display: 'flex', flexDirection: 'column', padding: 0, boxSizing: 'border-box', borderRadius: 0, background: 'transparent', color: 'inherit' },
  articleButton: { border: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer' },
  articleHeading: { display: 'flex', alignItems: 'center', gap: 6 },
  articleIcon: { width: 16, height: 16, flex: 'none', color: 'var(--dsw-alias-state-business-primary, #8295e8)' },
  articleTitle: { margin: 0, minWidth: 0, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflowWrap: 'anywhere', fontSize: 15, lineHeight: '22px', fontWeight: 600 },
  articlePreview: { maxWidth: '100%', margin: '8px 0 0', display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary, #68707c)', fontSize: 14, lineHeight: '20px' },
  articleMeta: { margin: '8px 0 0', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-label-tertiary, #9097a1)', fontSize: 12, lineHeight: '14px' },
  articleWordIcon: { width: 14, height: 14, flex: 'none' },
  forwardCard: { width: '100%', minWidth: 0, overflow: 'hidden', color: arkmeTheme.text },
  forwardTitle: { margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: '22px', fontWeight: 600 },
  forwardLines: { marginTop: 7, display: 'flex', flexDirection: 'column', gap: 0 },
  forwardLine: { margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: arkmeTheme.secondary, fontSize: 13, lineHeight: 1.65 },
  inlineLink: { display: 'inline-flex', alignItems: 'baseline', gap: 4, maxWidth: '100%', color: 'var(--dsw-alias-state-business-primary, #007aff)', textDecoration: 'none', cursor: 'pointer', verticalAlign: 'baseline' },
  inlineLinkTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  previewOverlay: { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 48, boxSizing: 'border-box', background: 'rgba(0,0,0,.78)' },
  previewBody: { position: 'relative', width: 'min(960px, 90vw)', height: 'min(720px, 82vh)' },
  previewViewport: { width: '100%', height: '100%', overflowX: 'hidden', overscrollBehavior: 'contain', scrollbarGutter: 'stable', touchAction: 'none' },
  previewCanvasContained: { width: '100%', height: '100%', overflow: 'hidden' },
  previewCanvasWidth: { width: '100%', minHeight: '100%', display: 'block' },
  previewImageContained: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none' },
  previewImageWidth: { display: 'block', width: '100%', height: 'auto', userSelect: 'none' },
  previewMedia: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none' },
  previewClose: { position: 'absolute', top: -36, right: 0, width: 32, height: 32, border: 0, borderRadius: 999, background: 'rgba(255,255,255,.16)', color: '#fff', cursor: 'pointer', fontSize: 20 },
  previewNav: { position: 'absolute', top: '50%', width: 38, height: 48, marginTop: -24, border: 0, borderRadius: 10, background: 'rgba(255,255,255,.16)', color: '#fff', cursor: 'pointer', fontSize: 24 },
}

export interface ArkmeLinkPreviewProjection {
  url: string
  sourceText: string
  title: string
  domain: string
  description?: string
  isMessageCopyLink: boolean
  sid?: string
}

function ensureUrlScheme(value: string): string {
  return /^https?:\/\//iu.test(value) ? value : `https://${value}`
}

function trimUrlCandidate(value: string): string {
  return value.replace(/[),.;:!?，。！？、；：）】》]+$/u, '')
}

function linkHostCandidates(shareWebsite: string): Set<string> {
  const shortLinkHost = 'ji' + 'wo.cc'
  const hosts = new Set([shortLinkHost, `www.${shortLinkHost}`, 'app.arkme.ai'])
  try {
    const parsed = new URL(ensureUrlScheme(shareWebsite.trim()))
    if (parsed.hostname.trim() !== '') hosts.add(parsed.hostname.toLowerCase())
    if (parsed.host.trim() !== '') hosts.add(parsed.host.toLowerCase())
  } catch {
    // Keep the built-in production hosts when the runtime config is unavailable.
  }
  return hosts
}

export function arkmeMessageCopyLinkSidFromUrl(rawUrl: string, shareWebsite = ARKME_DEFAULT_SHARE_WEBSITE): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(ensureUrlScheme(trimUrlCandidate(rawUrl.trim())))
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') return undefined
  if (!linkHostCandidates(shareWebsite).has(parsed.host.toLowerCase()) && !linkHostCandidates(shareWebsite).has(parsed.hostname.toLowerCase())) return undefined
  const match = /^\/s\/([0-9A-Za-z]{16})$/u.exec(parsed.pathname)
  return match?.[1]
}

export function arkmeExtractLinkPreviews(text: string, shareWebsite = ARKME_DEFAULT_SHARE_WEBSITE): ArkmeLinkPreviewProjection[] {
  const seen = new Set<string>()
  const previews: ArkmeLinkPreviewProjection[] = []
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`\\]+/giu
  for (const match of text.matchAll(pattern)) {
    const sourceText = trimUrlCandidate(match[0])
    const candidate = ensureUrlScheme(sourceText)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    let domain = ''
    try {
      domain = new URL(candidate).hostname.replace(/^www\./iu, '')
    } catch {
      continue
    }
    const sid = arkmeMessageCopyLinkSidFromUrl(candidate, shareWebsite)
    previews.push({
      url: candidate,
      sourceText,
      title: sid === undefined ? '分享链接' : '快记分享链接',
      domain,
      isMessageCopyLink: sid !== undefined,
      ...(sid === undefined ? {} : { sid }),
    })
    if (previews.length >= 5) break
  }
  return previews
}

export function arkmeTextWithoutPreviewLinks(text: string, previews: readonly ArkmeLinkPreviewProjection[]): string {
  let visible = text
  for (const preview of previews) {
    visible = visible.replace(preview.sourceText, '').replace(preview.url, '').replace(preview.url.replace(/^https:\/\//iu, 'www.'), '')
  }
  return visible.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

function metadataTitleFallback(preview: ArkmeLinkPreviewProjection): string {
  if (preview.isMessageCopyLink) return '快记分享链接'
  try {
    const parsed = new URL(preview.url)
    const host = parsed.hostname.replace(/^www\./iu, '')
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (host === 'github.com' && parts.length >= 4 && parts[2] === 'pull') return `Pull Request #${parts[3]} · ${parts[0]}/${parts[1]}`
    if ((host === 'codeup.aliyun.com' || host.endsWith('.codeup.aliyun.com')) && parts.includes('change')) {
      const changeIndex = parts.indexOf('change')
      const repository = changeIndex >= 2 ? parts[changeIndex - 1] : parts.at(-1)
      const changeNo = parts[changeIndex + 1]
      if (repository !== undefined && changeNo !== undefined) return `${repository} · Change #${changeNo}`
    }
  } catch {
    // Keep the generic Flutter fallback below for malformed browser-only candidates.
  }
  return preview.title
}

function ArkmeLinkIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
    <path d="M6.6 9.4L9.4 6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M6.05 5.1l.8-.8a3 3 0 0 1 4.24 4.24l-.8.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.95 10.9l-.8.8a3 3 0 0 1-4.24-4.24l.8-.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
}

function ArkmeInlineLinkPreview({
  preview,
  onMessageCopyLinkOpen,
}: {
  preview: ArkmeLinkPreviewProjection
  onMessageCopyLinkOpen?: (sid: string) => void
}) {
  const [metadata, setMetadata] = useState<ArkmeLinkMetadata>()
  useEffect(() => {
    if (preview.isMessageCopyLink) return
    const controller = new AbortController()
    void callArkme<ArkmeLinkMetadata>('source.link-metadata.resolve', { url: preview.url }, controller.signal)
      .then(value => { setMetadata(value) })
      .catch(() => { setMetadata({ url: preview.url, title: metadataTitleFallback(preview), siteName: preview.domain }) })
    return () => { controller.abort() }
  }, [preview.url, preview.isMessageCopyLink, preview.domain])
  const title = preview.isMessageCopyLink ? preview.title : (metadata?.title ?? metadataTitleFallback(preview))
  const open = () => {
    if (preview.sid !== undefined) {
      onMessageCopyLinkOpen?.(preview.sid)
      return
    }
    if (typeof window !== 'undefined') window.open(preview.url, '_blank', 'noopener,noreferrer')
  }
  return <span
    role="link"
    tabIndex={0}
    style={styles.inlineLink}
    data-arkme-inline-link={preview.isMessageCopyLink ? 'message-copy-link' : 'web-link'}
    title={preview.url}
    onClick={event => {
      event.stopPropagation()
      open()
    }}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.stopPropagation()
        event.preventDefault()
        open()
      }
    }}
  >
    <ArkmeLinkIcon />
    <span style={styles.inlineLinkTitle}>{title}</span>
  </span>
}

function ArkmeRichTextWithInlineLinks({
  text,
  previews,
  highlightMentions,
  onMessageCopyLinkOpen,
}: {
  text: string
  previews: ArkmeLinkPreviewProjection[]
  highlightMentions: boolean
  onMessageCopyLinkOpen?: (sid: string) => void
}) {
  if (previews.length === 0) return <ArkmeRichText text={text} highlightMentions={highlightMentions} />
  const nodes: ReactNode[] = []
  const previewByUrl = new Map(previews.map(preview => [preview.url, preview]))
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`\\]+/giu
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const raw = match[0] ?? ''
    const sourceText = trimUrlCandidate(raw)
    const trailingText = raw.slice(sourceText.length)
    const candidate = ensureUrlScheme(sourceText)
    const preview = previewByUrl.get(candidate)
    if (preview === undefined || match.index === undefined) continue
    if (match.index > cursor) {
      const before = text.slice(cursor, match.index)
      nodes.push(<ArkmeRichText key={`text:${String(index)}`} text={before} highlightMentions={highlightMentions} />)
      index += 1
    }
    nodes.push(<ArkmeInlineLinkPreview
      key={`link:${preview.url}:${String(index)}`}
      preview={preview}
      {...(onMessageCopyLinkOpen === undefined ? {} : { onMessageCopyLinkOpen })}
    />)
    index += 1
    if (trailingText !== '') {
      nodes.push(<ArkmeRichText key={`trail:${String(index)}`} text={trailingText} highlightMentions={highlightMentions} />)
      index += 1
    }
    cursor = match.index + raw.length
  }
  if (cursor < text.length) nodes.push(<ArkmeRichText key={`text:${String(index)}`} text={text.slice(cursor)} highlightMentions={highlightMentions} />)
  return <>{nodes}</>
}

function mediaUrl(block: ArkmeContentBlock): string {
  if (block.localFileRef !== undefined) return arkmeLocalFileUrl(block.localFileRef)
  return `${mediaRoute}?ref=${encodeURIComponent(block.mediaRef)}`
}

function UploadProgress({ block }: { block: ArkmeContentBlock }) {
  if (block.uploadProgress === undefined || block.uploadProgress.phase === 'ready') return null
  const percent = Math.floor(arkmeVisibleUploadFraction(block.uploadProgress) * 100)
  return <span role="progressbar" aria-label={`上传 ${block.fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.38)', color: '#fff', borderRadius: 8, fontSize: 12, pointerEvents: 'none' }}><span style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(255,255,255,.8)', display: 'grid', placeItems: 'center' }}>{percent}%</span></span>
}

function durationLabel(durationSec?: number): string {
  const total = Math.max(0, Math.round(durationSec ?? 0))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function normalizedTextLength(value: string): number {
  return Array.from(value.replace(/\[(?:jm_emoji|im_emoji):[^\]\r\n]+\]/gu, '●').trim()).length
}

function isEmojiOnly(value: string): boolean {
  const compact = value.replace(/\s/gu, '')
  if (compact === '') return false
  const withoutCustomEmoji = compact.replace(/\[(?:jm_emoji|im_emoji):[^\]\r\n]+\]/gu, '')
  return withoutCustomEmoji.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200D\uFE0F\u20E3]/gu, '') === ''
}

function shouldCollapseText(value: string): boolean {
  if (isEmojiOnly(value)) return false
  const newlineCount = (value.match(/\n/gu) ?? []).length
  return normalizedTextLength(value) > textCollapseCharacterThreshold || newlineCount > textCollapseNewlineThreshold
}

export interface ArkmeVisibleTextRun {
  kind: 'text' | 'mention'
  text: string
}

export function arkmeVisibleMentionRuns(text: string): ArkmeVisibleTextRun[] {
  const runs: ArkmeVisibleTextRun[] = []
  const pattern = /(^|[\s([{（【])(@[\p{L}\p{N}_\-·]+)/gmu
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? ''
    const value = match[2] ?? ''
    const start = match.index + prefix.length
    if (start > cursor) runs.push({ kind: 'text', text: text.slice(cursor, start) })
    runs.push({ kind: 'mention', text: value })
    cursor = start + value.length
  }
  if (cursor < text.length) runs.push({ kind: 'text', text: text.slice(cursor) })
  return runs.length === 0 && text !== '' ? [{ kind: 'text', text }] : runs
}

function HighlightedText({ text }: { text: string }) {
  return <>{arkmeVisibleMentionRuns(text).map((run, index) => <span
    key={`${String(index)}:${run.kind}:${run.text}`}
    style={run.kind === 'mention' ? { color: 'var(--dsw-alias-state-business-primary, #3964fe)' } : undefined}
  >{run.text}</span>)}</>
}

export function ArkmeRichText({ text, highlightMentions = false }: { text: string; highlightMentions?: boolean }) {
  return <>{arkmeEmojiTextRuns(text).map((run, index) => run.kind === 'emoji' && run.emoji !== undefined
    ? <img
      key={`${String(index)}:emoji:${run.emoji.id}`}
      src={run.emoji.assetUrl}
      alt={run.emoji.label}
      title={run.emoji.label}
      style={styles.emojiInline}
      draggable={false}
      data-arkme-rich-emoji={run.emoji.id}
    />
    : <span key={`${String(index)}:text`}>{highlightMentions ? <HighlightedText text={run.text} /> : run.text}</span>)}</>
}

function LongText({
  text,
  highlightMentions = false,
  collapseText = true,
  expanded = false,
  shareWebsite,
  onMessageCopyLinkOpen,
}: {
  text: string
  highlightMentions?: boolean
  collapseText?: boolean
  expanded?: boolean
  shareWebsite?: string
  onMessageCopyLinkOpen?: (sid: string) => void
}) {
  const collapsible = collapseText && !expanded && shouldCollapseText(text)
  const [collapsed, setCollapsed] = useState(collapsible)
  const previews = arkmeExtractLinkPreviews(text, shareWebsite)
  const content = <ArkmeRichTextWithInlineLinks
    text={text}
    previews={previews}
    highlightMentions={highlightMentions}
    {...(onMessageCopyLinkOpen === undefined ? {} : { onMessageCopyLinkOpen })}
  />
  if (!collapsible) return <p style={{ ...styles.text, ...(expanded ? { width: '100%', lineHeight: 1.7 } : {}) }}>{content}</p>
  return <div style={styles.textFrame} data-arkme-text-collapsible="true">
    <p style={{ ...styles.text, ...(collapsed ? styles.collapsedText : {}) }}>{content}</p>
    {collapsed && <span aria-hidden style={styles.textFade} />}
    <button type="button" style={styles.collapseToggle} aria-expanded={!collapsed} onClick={() => { setCollapsed(value => !value) }}>
      {collapsed ? '展开' : '收起'}
    </button>
  </div>
}

function mediaColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1
  if (count <= 4) return 2
  return 3
}

function MediaGallery({ blocks, onOpen, onFallback }: {
  blocks: ArkmeContentBlock[]
  onOpen: (block: ArkmeContentBlock) => void
  onFallback: (block: ArkmeContentBlock) => void
}) {
  const columns = mediaColumns(blocks.length)
  const tileSize = columns === 1 ? 150 : 75
  const width = tileSize * columns + mediaGap * (columns - 1)
  return <div
    style={{ ...styles.mediaGrid, width, gridTemplateColumns: `repeat(${String(columns)}, ${String(tileSize)}px)` }}
    data-arkme-media-count={blocks.length}
    data-arkme-media-columns={columns}
  >
    {blocks.map(block => {
      const src = mediaUrl(block)
      return <button
        key={`${block.mediaRef}:${String(block.sortOrder)}`}
        type="button"
        style={styles.mediaTile}
        aria-label={block.kind === 'video' ? `播放视频 ${block.fileName}` : `预览图片 ${block.fileName}`}
        onClick={() => { onOpen(block) }}
      >
        {block.kind === 'image'
          ? <img src={src} alt={block.fileName} loading="lazy" style={styles.mediaImage} onError={() => { onFallback(block) }} />
          : <>
            <video src={src} muted playsInline preload="metadata" style={styles.videoPreview} aria-hidden onError={() => { onFallback(block) }} />
            <span style={styles.videoBadge} aria-hidden>▶ {durationLabel(block.durationSec)}</span>
          </>}
        <UploadProgress block={block} />
      </button>
    })}
  </div>
}

export function ArkmeFileCard({ block, fallback = false, onOpen, previewOpen = false }: { block: ArkmeContentBlock; fallback?: boolean; onOpen?: (block: ArkmeContentBlock) => void; previewOpen?: boolean }) {
  const [open, setOpen] = useState(false)
  const original = useArkmeOriginal(block, false, open || previewOpen)
  const downloading = original.reception.state === 'receiving'
  const percent = original.reception.totalBytes > 0 ? Math.min(99, Math.floor(original.reception.receivedBytes / original.reception.totalBytes * 100)) : undefined
  const downloadLabel = original.localRef !== undefined ? '' : downloading ? `下载中${percent === undefined ? '' : ` ${percent}%`}` : original.reception.state === 'failed' ? '下载失败' : '未下载'
  return <><button type="button" onClick={event => { event.stopPropagation(); if (onOpen !== undefined) onOpen(block); else setOpen(true) }} style={{ ...styles.file, border: 0, textAlign: 'left', cursor: 'pointer', position: 'relative' }} data-arkme-file-card={fallback ? 'fallback' : 'file'}>
    <span style={{ ...styles.fileIconBox, position: 'relative' }}><ArkmeFileIcon fileName={block.fileName} mimeType={block.mimeType} /><UploadProgress block={block} /></span>
    <span><span style={styles.fileName}>{block.fileName || '未知文件'}</span><small style={{ color: arkmeTheme.tertiary }}>{arkmeFileSize(block.size)}{downloadLabel && ` · ${downloadLabel}`}</small></span>
    {downloading && <progress aria-label={`下载 ${block.fileName}`} max={100} value={percent} style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: '100%' }} />}
  </button>{open && <ArkmeFileViewer block={block} openLocalFile onClose={() => setOpen(false)} />}</>
}

function LongArticleWordCountIcon() {
  return <svg style={styles.articleWordIcon} viewBox="0 0 14 14" fill="none" aria-hidden focusable="false">
    <path d="M8.75 1.75H4.083c-.738 0-1.166 0-1.5.167a1.5 1.5 0 0 0-.666.666c-.167.334-.167.762-.167 1.5v5.834c0 .738 0 1.166.167 1.5.146.292.374.52.666.666.334.167.762.167 1.5.167h5.834c.738 0 1.166 0 1.5-.167.292-.146.52-.374.666-.666.167-.334.167-.762.167-1.5V5.25l-3.5-3.5Z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.75 1.75v2.333c0 .37 0 .584.083.75.073.146.188.261.334.334.166.083.38.083.75.083h2.333M4.667 7.583h4.666M4.667 9.625h2.916" stroke="currentColor" strokeWidth=".875" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function ArticleCard({ title, text, onOpen }: { title: string; text: string; onOpen: () => void }) {
  const heading = title.trim() || text.trim() || '无标题长文'
  const hasTitle = title.trim() !== ''
  const count = normalizedTextLength(text)
  return <button type="button" style={{ ...styles.article, ...styles.articleButton }} data-arkme-long-article="preview" data-arkme-long-article-inner="true" aria-label={`查看长文 ${heading}`} onClick={onOpen}>
    <div style={styles.articleHeading}>
      <h3 style={styles.articleTitle}>{heading}</h3>
    </div>
    {hasTitle && text.trim() !== '' && <p style={{ ...styles.articlePreview, WebkitLineClamp: 2 }}>{text}</p>}
    <span style={styles.articleMeta}><LongArticleWordCountIcon />{String(count)}字</span>
  </button>
}

type ImagePreviewMode = 'contained' | 'width'

export function arkmeNextImagePreviewMode(mode: ImagePreviewMode): ImagePreviewMode {
  return mode === 'contained' ? 'width' : 'contained'
}

interface ImagePreviewDragOrigin {
  clientY: number
  scrollTop: number
}

export function arkmeImagePreviewDragTop(origin: ImagePreviewDragOrigin, clientY: number): number {
  return origin.scrollTop + origin.clientY - clientY
}

export function arkmeImagePreviewAnchoredTop(imageYRatio: number, scrollHeight: number, pointerY: number): number {
  const ratio = Math.min(1, Math.max(0, imageYRatio))
  return Math.max(0, ratio * scrollHeight - pointerY)
}

interface ImagePreviewRect {
  left: number
  top: number
  width: number
  height: number
}

export function arkmeContainedImageRect(viewportWidth: number, viewportHeight: number, imageWidth: number, imageHeight: number): ImagePreviewRect {
  if (viewportWidth <= 0 || viewportHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(0, viewportWidth), height: Math.max(0, viewportHeight) }
  }
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return {
    left: (viewportWidth - width) / 2,
    top: (viewportHeight - height) / 2,
    width,
    height,
  }
}

export function ArkmeMediaPreview({ blocks, selected, onSelect, onClose, openLocalFile = true }: {
  blocks: ArkmeContentBlock[]
  selected: ArkmeContentBlock
  onSelect: (block: ArkmeContentBlock) => void
  onClose: () => void
  openLocalFile?: boolean
}) {
  const index = Math.max(0, blocks.findIndex(block => block.mediaRef === selected.mediaRef))
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragOriginRef = useRef<(ImagePreviewDragOrigin & { pointerId: number }) | undefined>(undefined)
  const zoomAnchorRef = useRef<{ imageYRatio: number; pointerY: number } | undefined>(undefined)
  const [imageMode, setImageMode] = useState<ImagePreviewMode>('contained')
  const [imageDragging, setImageDragging] = useState(false)
  const original = useArkmeOriginal(selected, selected.kind === 'image')
  const originalUrl = original.localRef === undefined ? mediaUrl(selected) : arkmeLocalFileUrl(original.localRef)

  useEffect(() => {
    setImageMode('contained')
    setImageDragging(false)
    dragOriginRef.current = undefined
    zoomAnchorRef.current = undefined
    const viewport = viewportRef.current
    if (viewport !== null) {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
    }
  }, [selected.mediaRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    if (imageMode === 'contained') {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
      return
    }
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = undefined
    if (anchor === undefined) return
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = 0
      viewport.scrollTop = arkmeImagePreviewAnchoredTop(anchor.imageYRatio, viewport.scrollHeight, anchor.pointerY)
    })
  }, [imageMode])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const toggleImageScale = (event: ReactMouseEvent<HTMLImageElement>) => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const nextMode = arkmeNextImagePreviewMode(imageMode)
    const viewportBounds = viewport.getBoundingClientRect()
    dragOriginRef.current = undefined
    setImageDragging(false)
    if (nextMode === 'width') {
      const imageRect = arkmeContainedImageRect(
        viewport.clientWidth,
        viewport.clientHeight,
        event.currentTarget.naturalWidth,
        event.currentTarget.naturalHeight,
      )
      const localX = event.clientX - viewportBounds.left
      const localY = event.clientY - viewportBounds.top
      if (localX < imageRect.left || localX > imageRect.left + imageRect.width || localY < imageRect.top || localY > imageRect.top + imageRect.height) return
      zoomAnchorRef.current = {
        imageYRatio: (localY - imageRect.top) / Math.max(1, imageRect.height),
        pointerY: localY,
      }
    } else {
      zoomAnchorRef.current = undefined
    }
    setImageMode(nextMode)
  }

  const beginImageDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (imageMode !== 'width' || event.button !== 0 || !event.isPrimary) return
    const viewport = viewportRef.current
    if (viewport === null || viewport.scrollHeight <= viewport.clientHeight) return
    dragOriginRef.current = {
      pointerId: event.pointerId,
      clientY: event.clientY,
      scrollTop: viewport.scrollTop,
    }
    viewport.setPointerCapture(event.pointerId)
    setImageDragging(true)
  }

  const moveImageDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current
    const viewport = viewportRef.current
    if (origin === undefined || origin.pointerId !== event.pointerId || viewport === null) return
    viewport.scrollLeft = 0
    viewport.scrollTop = arkmeImagePreviewDragTop(origin, event.clientY)
    event.preventDefault()
  }

  const endImageDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current
    if (origin === undefined || origin.pointerId !== event.pointerId) return
    dragOriginRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setImageDragging(false)
  }

  const selectMedia = (block: ArkmeContentBlock) => {
    setImageMode('contained')
    setImageDragging(false)
    dragOriginRef.current = undefined
    zoomAnchorRef.current = undefined
    onSelect(block)
  }

  if (selected.kind === 'file') return <ArkmeFileViewer block={selected} blocks={blocks} onSelect={onSelect} onClose={onClose} openLocalFile={openLocalFile} />

  return <div style={styles.previewOverlay} role="dialog" aria-modal="true" aria-label={selected.fileName} onClick={onClose}>
    <div style={styles.previewBody} onClick={event => { event.stopPropagation() }}>
      <button type="button" style={styles.previewClose} aria-label="关闭预览" onClick={onClose}>×</button>
      {selected.kind === 'image'
        ? <div
          ref={viewportRef}
          style={{
            ...styles.previewViewport,
            overflowY: imageMode === 'width' ? 'auto' : 'hidden',
            cursor: imageMode === 'contained' ? 'zoom-in' : imageDragging ? 'grabbing' : 'grab',
          }}
          data-arkme-image-preview-viewport="true"
          data-arkme-image-preview-mode={imageMode}
          onWheel={event => { event.stopPropagation() }}
          onPointerDown={beginImageDrag}
          onPointerMove={moveImageDrag}
          onPointerUp={endImageDrag}
          onPointerCancel={endImageDrag}
        >
          <div style={imageMode === 'contained' ? styles.previewCanvasContained : styles.previewCanvasWidth}>
            <img
              src={originalUrl}
              alt={selected.fileName}
              draggable={false}
              title={imageMode === 'contained' ? '双击铺满宽度' : '双击恢复整图'}
              style={{ ...(imageMode === 'contained' ? styles.previewImageContained : styles.previewImageWidth), cursor: 'inherit' }}
              onDoubleClick={toggleImageScale}
            />
          </div>
        </div>
        : <video src={originalUrl} controls autoPlay playsInline style={styles.previewMedia} aria-label={selected.fileName} />}
      <div style={{ position: 'absolute', bottom: -42, left: 0, right: 0, color: '#fff' }}><ArkmeFileActions block={selected} original={original} /></div>
      {blocks.length > 1 && <>
        <button type="button" aria-label="上一个媒体" disabled={index === 0} style={{ ...styles.previewNav, left: -54 }} onClick={() => { selectMedia(blocks[index - 1]!) }}>‹</button>
        <button type="button" aria-label="下一个媒体" disabled={index === blocks.length - 1} style={{ ...styles.previewNav, right: -54 }} onClick={() => { selectMedia(blocks[index + 1]!) }}>›</button>
      </>}
    </div>
  </div>
}

function splitVisualRuns(blocks: ArkmeContentBlock[]): Array<ArkmeContentBlock | ArkmeContentBlock[]> {
  const rows: Array<ArkmeContentBlock | ArkmeContentBlock[]> = []
  for (const block of blocks) {
    if (block.renderRole === 3 && block.kind === 'image') {
      rows.push(block)
      continue
    }
    if (block.kind !== 'image' && block.kind !== 'video') {
      rows.push(block)
      continue
    }
    const tail = rows.at(-1)
    if (Array.isArray(tail)) tail.push(block)
    else rows.push([block])
  }
  return rows
}

export function ArkmeMessageContent({ item, sourceRef, onLongArticleUpdated, highlightMentions = false, collapseText = true, presentation = 'bubble', shareWebsite, onMessageCopyLinkOpen }: {
  item: ArkmeTimelineItem
  presentation?: 'bubble' | 'detail'
  sourceRef?: string
  onLongArticleUpdated?: (detail: ArkmeLongArticleDetail) => void
  highlightMentions?: boolean
  collapseText?: boolean
  shareWebsite?: string
  onMessageCopyLinkOpen?: (sid: string) => void
}) {
  const lastMedia = useRef<{ sourceRef: string | undefined; item: ArkmeTimelineItem }>()
  const snapshot = lastMedia.current
  const previous = snapshot !== undefined && snapshot.sourceRef === sourceRef ? snapshot.item : undefined
  const version = item.recordVersion ?? item.version
  const sameRevision = version !== undefined && version > 0
    && version === (previous?.recordVersion ?? previous?.version)
  // A failed media lookup is not an authoritative attachment deletion. Keep only
  // this mounted record's same-version display until a complete response arrives.
  const retained = item.mediaUnavailable === true && sameRevision && item.status === 1
    && previous?.status === 1 && previous.itemUid === item.itemUid
    && (item.contentBlocks?.length ?? 0) === 0 ? previous.contentBlocks : undefined
  const displayBlocks = retained ?? item.contentBlocks
  useEffect(() => {
    lastMedia.current = { sourceRef, item: { ...item, ...(displayBlocks === undefined ? {} : { contentBlocks: displayBlocks }) } }
  }, [item, sourceRef, displayBlocks])
  const blocks = [...(displayBlocks ?? [])].sort((left, right) => left.sortOrder - right.sortOrder)
  const visualBlocks = blocks.filter(block => block.kind !== 'audio')
  const [preview, setPreview] = useState<ArkmeContentBlock>()
  const [articleOpen, setArticleOpen] = useState(false)
  const [failedRefs, setFailedRefs] = useState<Set<string>>(() => new Set())
  if (item.forwardRecords !== undefined) {
    const itemLines = item.forwardRecords.items.flatMap(value => {
      if (value.segments?.length) return value.segments.map(segment => `${segment.speakerName}：${segment.textContent || '语音片段'}`)
      const summary = value.textContent || value.title || value.contentLabel || value.contentBlocks?.[0]?.fileName || '非文本内容'
      return [`${value.senderName}：${summary}`]
    })
    const previewLines = (itemLines.length > 0 ? itemLines : item.forwardRecords.summaryLines).slice(0, 3)
    return <div style={styles.forwardCard} data-arkme-forward-records-card="true">
      <p style={styles.forwardTitle} title={item.forwardRecords.title}>{item.forwardRecords.title}</p>
      <div style={styles.forwardLines}>
        {(previewLines.length > 0 ? previewLines : ['原快记暂不可查看']).map((line, index) => <p
          key={`${String(index)}:${line}`}
          style={styles.forwardLine}
        >{line}</p>)}
      </div>
    </div>
  }
  const markFailed = (block: ArkmeContentBlock) => {
    setFailedRefs(current => new Set(current).add(block.mediaRef))
  }
  const isArticle = item.templateKind === 8 || item.displayKind === 1
  const text = item.textContent || (!isArticle && blocks.length === 0 ? item.title : '')
  // Only a voice note's single audio owns its transcript. Generic/mixed
  // attachments must keep their original ordering and separate body text.
  const isVoiceNote = item.templateKind === 3 || item.templateKind === 4
  const inlineVoice = !isArticle && (item.templateKind === undefined || isVoiceNote)
    && blocks.length === 1 && blocks[0]?.kind === 'audio' ? blocks[0] : undefined
  const renderVoice = (block: ArkmeContentBlock, withTranscript = false) => <ArkmeVoiceContent
    key={block.mediaRef}
    sourceKey={`${sourceRef ?? ''}:${item.itemUid}:${block.fileAssetUid ?? block.mediaRef}`}
    src={arkmeVoiceMediaUrl(block.mediaRef)}
    durationSeconds={block.durationSec ?? (isVoiceNote && item.recordDurationMillis !== undefined ? item.recordDurationMillis / 1000 : undefined)}
    downloadName={block.fileName}
    collapsible={withTranscript && presentation !== 'detail' && collapseText && shouldCollapseText(text)}
  >{withTranscript && text !== '' ? <ArkmeRichText text={text} highlightMentions={highlightMentions} /> : undefined}</ArkmeVoiceContent>
  const renderRows = splitVisualRuns(blocks).map((row, rowIndex) => {
    if (Array.isArray(row)) {
      const usable = row.filter(block => !failedRefs.has(block.mediaRef))
      const failed = row.filter(block => failedRefs.has(block.mediaRef))
      return <div key={`visual-row:${String(rowIndex)}`} style={styles.stack}>
        {usable.length > 0 && <MediaGallery blocks={usable} onOpen={setPreview} onFallback={markFailed} />}
        {failed.map(block => <ArkmeFileCard key={block.mediaRef} block={block} fallback onOpen={setPreview} previewOpen={preview?.mediaRef === block.mediaRef} />)}
      </div>
    }
    if (failedRefs.has(row.mediaRef)) return <ArkmeFileCard key={row.mediaRef} block={row} fallback onOpen={setPreview} previewOpen={preview?.mediaRef === row.mediaRef} />
    if (row.renderRole === 3 && row.kind === 'image') return <img
      key={row.mediaRef}
      src={mediaUrl(row)}
      alt={row.fileName}
      title={row.fileName}
      draggable={false}
      style={styles.sticker}
      data-arkme-chat-sticker="true"
      onClick={() => { setPreview(row) }}
      onError={() => { markFailed(row) }}
    />
    if (row.kind === 'audio') return renderVoice(row)
    return <ArkmeFileCard key={row.mediaRef} block={row} onOpen={setPreview} previewOpen={preview?.mediaRef === row.mediaRef} />
  })

  return <>
    <div style={{ ...styles.stack, ...(presentation === 'detail' ? { width: '100%' } : {}) }} data-arkme-message-content={isArticle ? 'article' : 'message'} data-arkme-content-presentation={presentation}>
      {inlineVoice !== undefined ? renderVoice(inlineVoice, true) : <>
        {isArticle && presentation === 'bubble' ? <ArticleCard title={item.title} text={item.textContent} onOpen={() => { setArticleOpen(true) }} /> : <>
          {isArticle && item.title && <h3 style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{item.title}</h3>}
          {text !== '' && <LongText
            text={text}
            highlightMentions={highlightMentions}
            collapseText={collapseText}
            expanded={presentation === 'detail'}
            {...(shareWebsite === undefined ? {} : { shareWebsite })}
            {...(onMessageCopyLinkOpen === undefined ? {} : { onMessageCopyLinkOpen })}
          />}
        </>}
        {renderRows}
      </>}
      {item.mediaUnavailable === true && (blocks.length > 0 || text !== '') && <p style={{ ...styles.text, color: arkmeTheme.tertiary, fontSize: 12 }}>部分媒体暂时无法加载，请刷新对话后重试</p>}
      {!isArticle && blocks.length === 0 && text === '' && <p style={styles.text}>
        {item.mediaUnavailable === true ? '媒体暂时无法加载' : '暂不支持的非文本内容'}
      </p>}
    </div>
    {preview !== undefined && typeof document !== 'undefined' && createPortal(
      <ArkmeMediaPreview blocks={visualBlocks} selected={preview} onSelect={setPreview} onClose={() => { setPreview(undefined) }} />,
      document.body,
    )}
    {articleOpen && sourceRef !== undefined && typeof document !== 'undefined' && createPortal(
      <ArkmeLongArticleDialog
        sourceRef={sourceRef}
        item={item}
        onClose={() => { setArticleOpen(false) }}
        {...(onLongArticleUpdated === undefined ? {} : { onUpdated: onLongArticleUpdated })}
      />,
      document.body,
    )}
  </>
}

/** The drawer keeps its existing text semantics while voice notes retain media. */
export function ArkmeRecordDetailContent({ item, sourceRef, showOriginal = false }: {
  item: ArkmeTimelineItem
  sourceRef?: string | undefined
  showOriginal?: boolean
}) {
  const text = showOriginal && item.aiPolish?.originalText !== undefined
    ? item.aiPolish.originalText
    : item.aiPolish?.state === 'polished' && item.aiPolish.polishedText !== undefined
      ? item.aiPolish.polishedText : item.textContent
  if (item.contentBlocks?.some(block => block.kind === 'audio') === true) {
    return <ArkmeMessageContent item={{ ...item, textContent: text }} {...(sourceRef === undefined ? {} : { sourceRef })} collapseText={false} />
  }
  return <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 16, lineHeight: '26px' }}><ArkmeRichText text={text || item.title || '非文本内容'} /></p>
}

export function ArkmeAttachmentDraftTile({ asset, previewUrl, onRemove, onOpen, disabled = false }: {
  asset: Pick<ArkmeUploadedAsset, 'fileName' | 'fileKind'> & Partial<Pick<ArkmeUploadedAsset, 'mimeType'>>
  previewUrl?: string
  onRemove: () => void
  onOpen?: () => void
  disabled?: boolean
}) {
  return <span
    data-arkme-attachment-tile={asset.fileKind === 1 && previewUrl !== undefined ? 'image-preview' : 'file-icon'}
    title={asset.fileName}
    aria-label={`附件 ${asset.fileName}`}
    style={{ position: 'relative', width: 48, height: 48, flex: 'none', display: 'inline-grid', placeItems: 'center', overflow: 'hidden', borderRadius: 8, background: 'var(--dsw-alias-bg-subtle, #f0f2f5)' }}
  >
    <button type="button" aria-label={`预览 ${asset.fileName}`} onClick={onOpen} disabled={onOpen === undefined} style={{ border: 0, padding: 0, width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'transparent', cursor: 'pointer' }}>{asset.fileKind === 1 && previewUrl !== undefined
      ? <img src={previewUrl} alt={asset.fileName} style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }} />
      : <ArkmeFileIcon fileName={asset.fileName} {...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType })} size={32} />}</button>
    <button
      type="button"
      aria-label={`移除${asset.fileName}`}
      disabled={disabled}
      onClick={onRemove}
      style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, display: 'grid', placeItems: 'center', border: 0, borderRadius: 999, padding: 0, background: 'var(--dsw-alias-bg-elevated, rgba(255,255,255,.9))', color: 'var(--dsw-alias-label-primary, #17191c)', boxShadow: '0 1px 3px rgba(0,0,0,.14)', cursor: 'pointer', fontSize: 13, lineHeight: '16px' }}
    >×</button>
  </span>
}
