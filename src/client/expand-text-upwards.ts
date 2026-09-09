import { flushSync } from 'react-dom'

/** Preserve the expansion button's viewport position, matching Flutter's reverse list. */
export function expandTextUpwards(button: HTMLElement, expand: () => void): void {
  const before = button.getBoundingClientRect().bottom
  flushSync(expand)
  let scrollport = button.parentElement
  while (scrollport !== null && (
    !/^(auto|scroll|overlay)$/u.test(getComputedStyle(scrollport).overflowY)
    || scrollport.scrollHeight <= scrollport.clientHeight
  )) {
    scrollport = scrollport.parentElement
  }
  if (scrollport !== null) {
    // Measure the remaining movement so browser scroll anchoring is not applied twice.
    scrollport.scrollTo({ top: scrollport.scrollTop + button.getBoundingClientRect().bottom - before, behavior: 'instant' })
  }
}
