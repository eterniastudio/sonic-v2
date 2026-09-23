import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, RotateCcw, Sparkles, Wand2, X } from 'lucide-react'
import type { Job, MetadataDraft, MetadataField } from '@shared/domain'
import { formatBpm, formatCents, formatDuration } from '@shared/format'
import { VERDICT_LABEL } from '@shared/verification'
import { renderTemplate } from '@shared/template'
import { cn } from '@/lib/cn'
import { useApp } from '@/store/app'
import { Accordion } from '@/components/ui/Accordion'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'

/** Locally-buffered field that commits on blur or Enter, not on every keystroke. */
function MetaField({
  label,
  hint,
  value,
  placeholder,
  mono,
  onCommit,
  type = 'text'
}: {
  label: string
  hint?: string
  value: string | number | null
  placeholder?: string
  mono?: boolean
  type?: 'text' | 'number'
  onCommit: (raw: string) => void
}): ReactNode {
  const external = value == null ? '' : String(value)
  const [local, setLocal] = useState(external)

  // Adopt external changes (probe results, resets) without stomping typing.
  useEffect(() => {
    setLocal(external)
  }, [external])

  const commit = (): void => {
    if (local !== external) onCommit(local)
  }

  return (
    <Field label={label} hint={hint}>
      <Input
        type={type}
        value={local}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(mono && 'font-mono text-[12.5px]')}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') setLocal(external)
        }}
      />
    </Field>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  filename: 'Filename',
  tags: 'Tags',
  manual: 'Manual'
}

/** Right-hand inspector: declared → suggested → final, with full provenance. */
export function MetadataInspector({ job }: { job: Job }): ReactNode {
  const settings = useApp((state) => state.settings)
  const updateJob = useApp((state) => state.updateJob)
  const setSelectedJob = useApp((state) => state.setSelectedJob)

  const draft = job.metadata
  const final = draft.final

  const edit = (field: MetadataField, raw: string): void => {
    const numeric = field === 'bpm' || field === 'altBpm' || field === 'detune'
    let value: string | number | null = raw.trim() === '' ? null : raw
    if (numeric) {
      const parsed = Number(raw)
      value = raw.trim() === '' || !Number.isFinite(parsed) ? null : parsed
    }
    void updateJob(job.id, { metadataEdit: { field, value } })
  }

  const preview = useMemo(
    () =>
      renderTemplate(settings.namingTemplate, {
        metadata: final,
        presetId: job.presetId,
        sourceKind: job.sourceKind,
        index: 1,
        durationSec: job.durationSec
      }),
    [settings.namingTemplate, final, job.presetId, job.sourceKind, job.durationSec]
  )

  const evidenceByField = useMemo(() => {
    const map = new Map<string, typeof draft.evidence>()
    for (const item of draft.evidence) {
      const bucket = map.get(item.field)
      if (bucket) bucket.push(item)
      else map.set(item.field, [item])
    }
    return map
  }, [draft.evidence])

  return (
    <aside className="flex min-h-0 w-[382px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-3">
        <Wand2 className="size-4 text-accent" />
        <h2 className="flex-1 text-[13px] font-semibold tracking-tight text-fg">Metadata</h2>
        {draft.overrides.length > 0 ? (
          <Badge size="sm" tone="accent">
            {draft.overrides.length} manual
          </Badge>
        ) : (
          <Badge size="sm">parsed</Badge>
        )}
        <IconButton label="Close inspector" size="icon-sm" onClick={() => setSelectedJob(null)}>
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5">
        <MetaField
          label="Title"
          value={final.title}
          placeholder="Beat title"
          onCommit={(raw) => edit('title', raw)}
        />

        <MetaField
          label="Producer"
          value={final.producer}
          placeholder="prod. by…"
          onCommit={(raw) => edit('producer', raw)}
        />

        <div className="grid grid-cols-2 gap-3">
          <MetaField
            label="BPM"
            hint={
              final.altBpm != null ? `alt ${final.altBpm}` : draft.suggested.bpm ? 'suggested' : undefined
            }
            value={final.bpm}
            type="number"
            placeholder="—"
            onCommit={(raw) => edit('bpm', raw)}
          />
          <MetaField
            label="Detune"
            hint="cents"
            value={final.detune}
            type="number"
            placeholder="—"
            onCommit={(raw) => edit('detune', raw)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <MetaField
            label="Key"
            value={final.key}
            placeholder="F# minor"
            onCommit={(raw) => edit('key', raw)}
          />
          <MetaField
            label="Camelot"
            value={final.camelot}
            placeholder="11A"
            onCommit={(raw) => edit('camelot', raw)}
          />
        </div>

        <MetaField
          label="Genre"
          value={final.genre}
          placeholder="Trap, Drill, R&B…"
          onCommit={(raw) => edit('genre', raw)}
        />

        {/* Live filename preview — the exact name the exporter will write. */}
        <div className="rounded-[10px] border border-line bg-surface-2 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">
            <Sparkles className="size-3" />
            Output file name
          </div>
          <div className="font-mono text-[11.5px] leading-relaxed break-all text-fg">
            {preview.rendered || 'untitled'}
          </div>
          {preview.unknownTokens.length > 0 ? (
            <div className="mt-1.5 text-[11px] text-warning">
              Unknown token{preview.unknownTokens.length === 1 ? '' : 's'}:{' '}
              {preview.unknownTokens.join(', ')}
            </div>
          ) : null}
        </div>

        <Accordion
          title="Evidence"
          summary={`${draft.evidence.length}`}
          defaultOpen={draft.evidence.length > 0}
        >
          {draft.evidence.length === 0 ? (
            <p className="text-[12px] text-fg-subtle">
              Nothing was declared in the source text for this beat.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...evidenceByField.entries()].map(([field, entries]) => (
                <li key={field} className="flex gap-2.5">
                  <span className="w-[74px] shrink-0 pt-0.5 text-[11.5px] font-medium text-fg-muted">
                    {field}
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    {entries.map((entry, index) => (
                      <span key={index} className="block">
                        <span className="text-[12px] text-fg">{entry.value}</span>
                        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-subtle" title={entry.matched}>
                          {SOURCE_LABEL[entry.source] ?? entry.source} · “{entry.matched}”
                        </span>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Accordion>

        {draft.conflicts.length > 0 ? (
          <Accordion title="Conflicts" summary={`${draft.conflicts.length}`} defaultOpen>
            <ul className="space-y-2">
              {draft.conflicts.map((conflict) => (
                <li key={conflict.field} className="flex items-start gap-2 text-[11.5px]">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span className="min-w-0">
                    <span className="font-medium text-fg">{conflict.field}</span>
                    <span className="block text-fg-muted">
                      text “{conflict.declared}” vs tags “{conflict.embedded}”
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Accordion>
        ) : null}

        <Accordion title="Source" summary={job.uploader ?? undefined}>
          <dl className="space-y-2 text-[11.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">Duration</dt>
              <dd className="text-fg nums">{formatDuration(job.durationSec)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">Detune</dt>
              <dd className="text-fg nums">{formatCents(final.detune)}</dd>
            </div>
            {job.sourceTitle ? (
              <div className="space-y-1">
                <dt className="text-fg-subtle">Original title</dt>
                <dd className="leading-relaxed break-words text-fg-muted">{job.sourceTitle}</dd>
              </div>
            ) : null}
          </dl>
        </Accordion>

        <AnalysisPanel job={job} />
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-line p-2.5">
        <button
          type="button"
          disabled={draft.overrides.length === 0}
          onClick={() => void updateJob(job.id, { clearOverrides: draft.overrides })}
          className="flex w-full items-center justify-center gap-1.5 rounded-[9px] border border-line bg-surface-2 px-3 py-2 text-[12px] text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" />
          Clear {draft.overrides.length} manual override{draft.overrides.length === 1 ? '' : 's'}
        </button>
      </div>
    </aside>
  )
}

/**
 * Acoustic analysis results and the declared-vs-measured cross-check.
 *
 * This is where a producer sees whether the video's title and description agree
 * with what the engine actually measured, and can adopt or reject the estimate
 * per field. Only actions that exist are shown.
 */
function AnalysisPanel({ job }: { job: Job }): ReactNode {
  const updateJob = useApp((state) => state.updateJob)
  const draft = job.metadata
  const analysis = draft.analysis
  const verification = draft.verification

  const adoptable = (['bpm', 'key'] as const).filter(
    (field) => draft.analyzed[field] != null && !draft.overrides.includes(field)
  )

  return (
    <Accordion
      title="Audio analysis"
      summary={analysis ? describeStatus(analysis) : 'not run'}
      defaultOpen={analysis != null}
    >
      {!analysis ? (
        <p className="text-[12px] leading-relaxed text-fg-subtle">
          {job.stage === 'analyzing'
            ? 'Analyzing the audio now…'
            : 'No analysis has run for this track yet.'}
        </p>
      ) : (
        <div className="space-y-3">
          <dl className="space-y-1.5 text-[11.5px]">
            <AnalysisRow
              label="Tempo"
              value={
                analysis.tempo.bpm != null
                  ? `${formatBpm(analysis.tempo.bpm)} BPM`
                  : 'no reliable tempo'
              }
              quality={analysis.tempo.confidence}
              status={analysis.tempo.status}
            />
            <AnalysisRow
              label="Key"
              value={analysis.key.key ?? 'no reliable key'}
              quality={analysis.key.confidence}
              status={analysis.key.status}
            />
            {analysis.key.tuningCents != null ? (
              <div className="flex justify-between gap-3">
                <dt className="text-fg-subtle">Estimated tuning</dt>
                <dd className="text-fg nums">{formatCents(analysis.key.tuningCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">Examined</dt>
              <dd className="text-fg nums">
                {Math.round(analysis.analyzedSeconds)}s of {Math.round(analysis.durationSec)}s
              </dd>
            </div>
          </dl>

          {analysis.tempo.alternatives.length > 0 || analysis.key.alternatives.length > 0 ? (
            <div className="space-y-1 text-[11px] text-fg-subtle">
              {analysis.tempo.alternatives.length > 0 ? (
                <div>
                  <span className="text-fg-muted">Tempo readings: </span>
                  {analysis.tempo.alternatives
                    .map((entry) => `${formatBpm(entry.bpm)} ${entry.relation}`)
                    .join(' · ')}
                </div>
              ) : null}
              {analysis.key.alternatives.length > 0 ? (
                <div>
                  <span className="text-fg-muted">Key candidates: </span>
                  {analysis.key.alternatives.map((entry) => entry.key).join(' · ')}
                </div>
              ) : null}
            </div>
          ) : null}

          {analysis.warnings.length > 0 ? (
            <ul className="space-y-1">
              {analysis.warnings.map((warning) => (
                <li key={warning} className="flex gap-1.5 text-[11px] leading-relaxed text-warning">
                  <CircleAlert className="mt-0.5 size-3 shrink-0" />
                  <span className="min-w-0">{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {adoptable.length > 0 ? (
            <button
              type="button"
              onClick={() => void updateJob(job.id, { adoptAnalyzed: [...adoptable] })}
              className="flex w-full items-center justify-center gap-1.5 rounded-[8px] bg-accent-soft px-3 py-1.5 text-[11.5px] font-medium text-accent transition-colors duration-[var(--duration-quick)] hover:bg-[var(--sonic-accent-line)]"
            >
              <Wand2 className="size-3.5" />
              Use detected {adoptable.join(' + ')}
            </button>
          ) : null}
        </div>
      )}

      {verification && verification.fields.length > 0 ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="text-[10.5px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">
            Source vs audio
          </div>
          {verification.fields.map((field) => (
            <div key={field.field} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] font-medium text-fg capitalize">{field.field}</span>
                <Badge size="sm" tone={VERDICT_TONE[field.verdict]}>
                  {VERDICT_LABEL[field.verdict]}
                </Badge>
              </div>
              <ul className="space-y-0.5">
                {field.candidates.map((candidate, index) => (
                  <li
                    key={`${candidate.origin}-${index}`}
                    className="flex justify-between gap-3 text-[11px]"
                  >
                    <span className="text-fg-subtle">{candidate.label}</span>
                    <span className="text-fg nums">{candidate.value}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] leading-relaxed text-fg-subtle">{field.note}</p>
            </div>
          ))}
        </div>
      ) : null}
    </Accordion>
  )
}

const VERDICT_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  match: 'success',
  close: 'warning',
  mismatch: 'danger',
  'single-source': 'neutral',
  'no-evidence': 'neutral'
}

function describeStatus(analysis: NonNullable<MetadataDraft['analysis']>): string {
  if (analysis.tempo.status === 'estimated' && analysis.key.status === 'estimated') return 'complete'
  if (analysis.tempo.status === 'estimated' || analysis.key.status === 'estimated') return 'partial'
  return 'inconclusive'
}

function AnalysisRow({
  label,
  value,
  quality,
  status
}: {
  label: string
  value: string
  quality: number | null
  status: string
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className={status === 'estimated' ? 'text-fg' : 'text-fg-subtle'}>{value}</span>
        {quality != null ? (
          <span className="ml-1.5 text-[10.5px] text-fg-subtle nums">
            {Math.round(quality * 100)}% quality
          </span>
        ) : null}
      </dd>
    </div>
  )
}
