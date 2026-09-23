import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { createPortal } from 'react-dom'
import { overlayRoot, useOverlay } from '../motion/overlay'
import { useReducedMotion } from '@/lib/theme'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Apple Spotlight*.
 *
 * A centred, blurred-glass command palette: rotating through navigation, engine
 * actions and export presets from one keystroke. Keyboard-first — the pointer is
 * optional here.
 */

export interface SpotlightItem {
  id: string
  label: string
  group: string
  hint?: string
  icon?: ReactNode
  /** Extra text folded into the search index. */
  keywords?: string
  disabled?: boolean
  onSelect: () => void
}

export interface AppleSpotlightProps {
  open: boolean
  onClose: () => void
  items: SpotlightItem[]
  placeholder?: string
  emptyLabel?: string
}

/** Substring + word-prefix scoring; enough for a few dozen commands. */
function score(item: SpotlightItem, query: string): number {
  if (query.length === 0) return 1
  const haystack = `${item.label} ${item.group} ${item.keywords ?? ''}`.toLowerCase()
  const needle = query.toLowerCase()

  const direct = haystack.indexOf(needle)
  if (direct !== -1) return 100 - direct

  // Fall back to matching every character in order.
  let cursor = 0
  let gaps = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return 0
    gaps += found - cursor
    cursor = found + 1
  }
  return Math.max(1, 40 - gaps)
}

export function AppleSpotlight({
  open,
  onClose,
  items,
  placeholder = 'Search beats, commands and settings…',
  emptyLabel = 'Nothing matches that.'
}: AppleSpotlightProps): ReactNode {
  const reduced = useReducedMotion()
  const panelRef = useRef<HTMLDivElement | null>(null)
  useOverlay([panelRef], onClose, open, true)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const results = useMemo(() => {
    const scored = items
      .filter((item) => !item.disabled)
      .map((item) => ({ item, value: score(item, query) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((entry) => entry.item)

    // Group while preserving the relevance order established above.
    const groups = new Map<string, SpotlightItem[]>()
    for (const item of scored) {
      const bucket = groups.get(item.group)
      if (bucket) bucket.push(item)
      else groups.set(item.group, [item])
    }
    return [...groups.entries()].flatMap(([, groupItems]) => groupItems)
  }, [items, query])

  // Reset the cursor whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0)
  }, [query, open])

  useEffect(() => {
    if (open) {
      setQuery('')
      const frame = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    return undefined
  }, [open])

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const commit = (item: SpotlightItem | undefined): void => {
    if (!item) return
    onClose()
    item.onSelect()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(results[activeIndex])

    }
  }

  let lastGroup = ''

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div inert={!open} style={{ pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-0 z-[400] flex items-start justify-center pt-[14vh]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}

            className="absolute inset-0 bg-overlay backdrop-blur-[6px]"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.965, y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.98, y: -4, filter: 'blur(4px)' }}
            transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="glass-strong relative w-full max-w-[620px] overflow-hidden rounded-[16px] border border-line shadow-pop"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className="h-13 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-subtle"
              />
              <kbd className="shrink-0 rounded-[5px] border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle">
                ESC
              </kbd>
            </div>

            <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-2">
              {results.length === 0 ? (
                <div className="px-3 py-10 text-center text-[13px] text-fg-subtle">{emptyLabel}</div>
              ) : (
                results.map((item, index) => {
                  const showHeader = item.group !== lastGroup
                  lastGroup = item.group
                  const active = index === activeIndex

                  return (
                    <div key={item.id}>
                      {showHeader ? (
                        <div className="px-2.5 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">
                          {item.group}
                        </div>
                      ) : null}

                      <button
                        type="button"
                        data-index={index}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => commit(item)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left',
                          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
                          active ? 'bg-accent-soft' : 'hover:bg-surface-2'
                        )}
                      >
                        {item.icon ? (
                          <span
                            className={cn(
                              'grid size-4 shrink-0 place-items-center',
                              active ? 'text-accent' : 'text-fg-subtle'
                            )}
                          >
                            {item.icon}
                          </span>
                        ) : null}

                        <span
                          className={cn(
                            'flex-1 truncate text-[13px]',
                            active ? 'text-fg' : 'text-fg-muted'
                          )}
                        >
                          {item.label}
                        </span>

                        {item.hint ? (
                          <span className="shrink-0 text-[11px] text-fg-subtle nums">{item.hint}</span>
                        ) : null}

                        {active ? (
                          <CornerDownLeft className="size-3.5 shrink-0 text-accent" />
                        ) : null}
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>, overlayRoot()
  )
}
