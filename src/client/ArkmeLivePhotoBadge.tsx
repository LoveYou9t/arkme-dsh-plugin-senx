/** Flutter shared/ui/media/live_mode_badge.dart geometry, shared by both Live preview surfaces. */
export function ArkmeLivePhotoBadge({ playable, compact = false }: { playable: boolean; compact?: boolean }) {
  const size = compact ? 16 : playable ? 22 : 18
  const target = compact ? 20 : playable ? 32 : 24
  const stroke = !compact && playable ? 1.32 : 1.24
  return <span data-arkme-live-photo-badge style={{ display: 'inline-grid', placeItems: 'center', width: target, height: target, borderRadius: '50%', background: 'rgba(0,0,0,.34)', color: playable ? 'rgba(255,255,255,.98)' : 'rgba(255,255,255,.76)' }}>
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="1.56" fill="currentColor" />
      <circle cx="10" cy="10" r="3.8" stroke="currentColor" strokeWidth={stroke * .76} />
      {Array.from({ length: 14 }, (_, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / 14
        return <circle key={index} cx={10 + Math.cos(angle) * 8} cy={10 + Math.sin(angle) * 8} r=".32" stroke="currentColor" strokeWidth={stroke} />
      })}
      {!playable && <path d="M4 4.8 16 15.2" stroke="currentColor" strokeWidth={stroke + .6} strokeLinecap="round" />}
    </svg>
  </span>
}
