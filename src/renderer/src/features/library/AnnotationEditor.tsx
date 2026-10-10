import { useEffect, useState, type ReactNode } from 'react'
import { Star } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { OrganizationCommand, OrganizationSnapshot, UserAnnotation } from '@shared/organization'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

const EMPTY: UserAnnotation = { favorite: false, tags: [], notes: '' }

/** Producer annotations are library-only; saving never changes the audio or tags. */
export function AnnotationEditor({ beat, annotation, command }: {
  beat: LibraryBeat
  annotation?: UserAnnotation
  command: (command: OrganizationCommand) => Promise<OrganizationSnapshot>
}): ReactNode {
  const current = annotation ?? EMPTY
  // Null means untouched. An empty string means the producer deliberately cleared it.
  const [draft, setDraft] = useState<{ tags: string | null; notes: string | null }>({ tags: null, notes: null })
  const tags = draft.tags ?? current.tags.join(', ')
  const notes = draft.notes ?? current.notes
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setDraft({ tags: null, notes: null }); setError('') }, [beat.id])
  const save = async (patch: { favorite?: boolean; tags?: string[]; notes?: string }, submitted?: typeof draft): Promise<void> => {
    setPending(true); setError('')
    try {
      await command({ type: 'set-annotation', beatId: beat.id, ...patch })
      if (submitted) setDraft(previous => ({
        tags: submitted.tags !== null && previous.tags === submitted.tags ? null : previous.tags,
        notes: submitted.notes !== null && previous.notes === submitted.notes ? null : previous.notes
      }))
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setPending(false) }
  }
  return <section aria-label="Your annotations" className="border-t border-line px-4 py-4 text-[12px] text-fg-muted">
    <div className="flex items-center gap-2">
      <strong className="section-label">Notes &amp; tags</strong>
      <span className="flex-1" />
      <button type="button" aria-label={current.favorite ? `Unfavorite ${beat.title}` : `Favorite ${beat.title}`}
        aria-pressed={current.favorite} disabled={pending} onClick={() => void save({ favorite: !current.favorite })}
        className="flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"><Star className="size-3.5" fill={current.favorite ? 'currentColor' : 'none'} />Favorite</button>
    </div>
    <div className="mt-3 grid gap-3">
      <label className="text-[11px] text-fg-muted"><span className="mb-1.5 block">User tags</span><Input aria-label="User tags" value={tags} maxLength={1200} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, tags: event.target.value }))} placeholder="dark, good for vocals" /></label>
      <label className="text-[11px] text-fg-muted">Notes<textarea aria-label="Notes" value={notes} maxLength={4000} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} placeholder="Good hook section at 0:48"
        className="mt-1.5 block min-h-[64px] w-full resize-y rounded-[6px] border border-line-strong/60 bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-fg placeholder:text-fg-subtle focus:border-accent" /></label>
    </div>
    <div className="mt-3 space-y-2">
      <Button size="sm" variant="secondary" className="w-full" disabled={pending || (draft.tags === null && draft.notes === null)} onClick={() => {
        const submitted = { ...draft }
        void save({
          ...(submitted.tags !== null ? { tags: submitted.tags.split(',').map(item => item.trim()).filter(Boolean) } : {}),
          ...(submitted.notes !== null ? { notes: submitted.notes } : {})
        }, submitted)
      }}>Save annotations</Button>
      <p className="text-center text-[10px] text-fg-subtle">Saved in Sonic’s library only.</p>
    </div>
    {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
  </section>
}
