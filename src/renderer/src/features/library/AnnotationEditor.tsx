import { useEffect, useState, type ReactNode } from 'react'
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
  return <section aria-label="Your annotations" className="rounded-[12px] border border-line bg-surface px-3 py-2.5 text-[12px] text-fg-muted">
    <div className="flex items-center gap-2">
      <strong className="text-fg">Your annotations</strong>
      <span className="flex-1" />
      <button type="button" aria-label={current.favorite ? `Unfavorite ${beat.title}` : `Favorite ${beat.title}`}
        aria-pressed={current.favorite} disabled={pending} onClick={() => void save({ favorite: !current.favorite })}
        className="rounded-[8px] px-2 py-1 text-accent hover:bg-accent-soft">{current.favorite ? '★ Favorite' : '☆ Favorite'}</button>
    </div>
    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <label>User tags<Input aria-label="User tags" value={tags} maxLength={1200} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, tags: event.target.value }))} placeholder="dark, good for vocals" /></label>
      <label>Notes<textarea aria-label="Notes" value={notes} maxLength={4000} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} placeholder="Good hook section at 0:48"
        className="mt-1 block min-h-10 w-full rounded-[8px] border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-fg" /></label>
    </div>
    <div className="mt-2 flex items-center gap-2">
      <Button size="sm" disabled={pending || (draft.tags === null && draft.notes === null)} onClick={() => {
        const submitted = { ...draft }
        void save({
          ...(submitted.tags !== null ? { tags: submitted.tags.split(',').map(item => item.trim()).filter(Boolean) } : {}),
          ...(submitted.notes !== null ? { notes: submitted.notes } : {})
        }, submitted)
      }}>Save annotations</Button>
      <span>Saved in Sonic’s library only.</span>
    </div>
    {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
  </section>
}
