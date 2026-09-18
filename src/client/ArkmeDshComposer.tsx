import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode, Ref } from 'react'
import css from './arkme-dsh-composer.css?inline'

/** Presentation only: the caller owns the editor, commands and all business state. */
export interface ArkmeDshComposerProps {
  children: ReactNode
  tools: ReactNode
  trailing: ReactNode
  hint: string
  cardRef?: Ref<HTMLDivElement>
}

/** DSH public primitives and theme, without importing its private session composer. */
export function ArkmeDshComposer({ children, tools, trailing, hint, cardRef }: ArkmeDshComposerProps) {
  return <div ref={cardRef} className="arkme-dsh-composer">
    <style>{css}</style>
    <div className="arkme-dsh-composer-editor">{children}</div>
    <div className="arkme-dsh-composer-toolbar">
      <div className="arkme-dsh-composer-tools">{tools}</div>
      <span className="arkme-dsh-composer-hint" role="status">{hint}</span>
      <div className="arkme-dsh-composer-trailing">{trailing}</div>
    </div>
  </div>
}

export function ArkmeDshComposerAction({ label, ariaLabel = label, icon, disabled, onClick }: {
  label: string
  ariaLabel?: string
  icon: ReactNode
  disabled: boolean
  onClick(): void
}) {
  return <Button type="button" variant="primary" className="arkme-dsh-composer-primary"
    title={label} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>{icon}</Button>
}
