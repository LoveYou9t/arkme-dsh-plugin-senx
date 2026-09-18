import { Button, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect } from 'react'
import type { ArkmeArkoModelCatalog } from '../types.js'
import { ArkmeDshMenu } from './ArkmeDshMenu.js'
import { arkmeTheme } from './arkme-theme.js'

/** Arko route keys are not DSH provider/model pairs. Only menu rendering is shared. */
export function ArkmeArkoModelMenu({ catalog, name, open, disabled, busy, onToggle, onClose, onSelect }: {
  catalog: ArkmeArkoModelCatalog | undefined
  name: string
  open: boolean
  disabled: boolean
  busy: boolean
  onToggle(): void
  onClose(): void
  onSelect(routeKey: string): void
}) {
  useEffect(() => {
    if (open && disabled) onClose()
  }, [disabled, onClose, open])

  return <ArkmeDshMenu label="模型选择" open={open && !disabled} side="top" align="end" portal
    selectedIds={catalog === undefined ? [] : [catalog.effectiveRouteKey]}
    onClose={onClose} onSelect={onSelect}
    items={[
      { type: 'label', id: 'arko-model-note', text: '仅影响之后发起的新任务' },
      ...(catalog?.options ?? []).map(option => ({
        id: option.routeKey,
        disabled: busy || option.routeKey === catalog?.effectiveRouteKey,
        // Leave room for the host menu's padding and selection marker on small viewports.
        label: <span style={{ display: 'block', minWidth: 0, maxWidth: 'min(280px, calc(100vw - 96px))', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          <span>{option.displayName}</span>
          {option.recommended && <small style={{ marginLeft: 8, color: arkmeTheme.secondary }}>推荐</small>}
          {option.description && <small style={{ display: 'block', color: arkmeTheme.secondary }}>{option.description}</small>}
        </span>,
      })),
    ]}
    anchor={<Button type="button" size="sm" variant="ghost" title="选择模型" aria-label={`模型选择：${name}`}
      aria-haspopup="menu" aria-expanded={open && !disabled} aria-busy={busy || undefined}
      disabled={disabled || busy} onClick={onToggle}
      style={{ minWidth: 0, maxWidth: 'min(240px, 45vw)', color: arkmeTheme.secondary }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <IconChevronDownOutline14 />
    </Button>}
  />
}
