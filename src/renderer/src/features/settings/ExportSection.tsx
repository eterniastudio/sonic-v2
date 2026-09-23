import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, Gauge, Repeat2 } from 'lucide-react'
import type { ChannelMode, PresetId } from '@shared/domain'
import { PRESETS } from '@shared/presets'
import { TEMPLATE_TOKEN_HELP, TEMPLATE_TOKENS } from '@shared/template'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useDebounced } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dropdown, DropdownItem } from '@/components/ui/Dropdown'
import { Field, Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { SwitchRow } from '@/components/ui/Switch'
import { Accordion } from '@/components/ui/Accordion'
import { FolderPreview } from '@/components/obsidian/FolderPreview'

export function ExportSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const chooseDownloadDir = useApp((state) => state.chooseDownloadDir)
  const library = useApp((state) => state.library)

  const [template, setTemplate] = useState(settings.namingTemplate)
  const [preview, setPreview] = useState<{ rendered: string; unknownTokens: string[] } | null>(null)
  const debounced = useDebounced(template, 220)

  useEffect(() => {
    setTemplate(settings.namingTemplate)
  }, [settings.namingTemplate])

  // Preview through the main process so Settings shows exactly what the
  // exporter will produce, using the same renderer function.
  useEffect(() => {
    let cancelled = false
    void ipc
      .invoke('settings:previewTemplate', debounced, settings.defaultPresetId)
      .then((result) => {
        if (!cancelled) setPreview({ rendered: result.rendered, unknownTokens: result.unknownTokens })
      })
    return () => {
      cancelled = true
    }
  }, [debounced, settings.defaultPresetId])

  const preset = PRESETS.find((entry) => entry.id === settings.defaultPresetId) ?? PRESETS[0]

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <h3 className="text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Destination
        </h3>

        <Field label="Export folder" hint="Where finished beats are published">
          <div className="flex gap-2">
            <Input
              value={settings.downloadDir}
              readOnly
              className="font-mono text-[11.5px]"
              leading={<FolderOpen />}
            />
            <Button variant="secondary" onClick={() => void chooseDownloadDir()}>
              Change
            </Button>
          </div>
        </Field>

        <FolderPreview
          path={settings.downloadDir}
          files={library.slice(0, 12).map((beat) => ({ name: beat.fileName, sizeBytes: beat.sizeBytes }))}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Naming
        </h3>

        <Field
          label="File name template"
          hint={`${TEMPLATE_TOKENS.length} tokens available`}
          note={
            preview?.unknownTokens.length
              ? `Unknown token: ${preview.unknownTokens.join(', ')}`
              : undefined
          }
        >
          <Input
            value={template}
            spellCheck={false}
            className="font-mono text-[12px]"
            onChange={(event) => setTemplate(event.target.value)}
            onBlur={() => void patchSettings({ namingTemplate: template })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void patchSettings({ namingTemplate: template })
            }}
          />
        </Field>

        <div className="rounded-[10px] border border-line bg-surface-2 p-3">
          <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">
            Preview
          </div>
          <div className="font-mono text-[11.5px] break-all text-fg">
            {preview?.rendered || 'untitled'}.{preset.extension}
          </div>
        </div>

        <Accordion title="Available tokens" summary={`${TEMPLATE_TOKEN_HELP.length}`}>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {TEMPLATE_TOKEN_HELP.map((entry) => (
              <li key={entry.token} className="flex items-baseline gap-2">
                <code className="shrink-0 rounded-[4px] bg-surface-3 px-1 py-0.5 font-mono text-[10.5px] text-accent">
                  {`{${entry.token}}`}
                </code>
                <span className="truncate text-[11px] text-fg-muted">{entry.description}</span>
              </li>
            ))}
          </ul>
        </Accordion>
      </section>

      <section className="space-y-3">
        <h3 className="text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Default recipe
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Format for new downloads">
            <Dropdown
              width="trigger"
              className="w-full"
              trigger={({ toggle }) => (
                <Button variant="secondary" className="w-full justify-between" onClick={toggle}>
                  {preset.label}
                </Button>
              )}
            >
              {(close) => (
                <>
                  {PRESETS.map((entry) => (
                    <DropdownItem
                      key={entry.id}
                      selected={entry.id === settings.defaultPresetId}
                      hint={entry.short}
                      onSelect={async () => {
                      await patchSettings({ defaultPresetId: entry.id as PresetId })
                      close()
                      }}
                    >
                      {entry.label}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
          </Field>

          <Field label="Channels">
            <Segmented
              value={settings.channelMode}
              onChange={(next: ChannelMode) => void patchSettings({ channelMode: next })}
              ariaLabel="Channel mode"
              options={[
                { value: 'preserve', label: 'Keep' },
                { value: 'stereo', label: 'Stereo' },
                { value: 'mono', label: 'Mono' }
              ]}
            />
          </Field>
        </div>

        <p className="text-[11.5px] leading-relaxed text-fg-subtle">{preset.description}</p>

        <Field
          label="Loudness normalisation"
          hint="Off by default — on changes the audio"
          note="Uses ffmpeg loudnorm. Leave this off unless a destination specifically asks for a target."
        >
          <div className="flex items-center gap-2">
            <Segmented
              value={settings.normalizeLufs == null ? 'off' : 'on'}
              onChange={(next) =>
                void patchSettings({ normalizeLufs: next === 'off' ? null : (settings.normalizeLufs ?? -14) })
              }
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'Target' }
              ]}
              size="sm"
            />
            {settings.normalizeLufs != null ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={-24}
                  max={-8}
                  step={1}
                  value={settings.normalizeLufs}
                  onChange={(event) => void patchSettings({ normalizeLufs: Number(event.target.value) })}
                  className="w-32 accent-[var(--sonic-accent)]"
                />
                <Badge tone="accent" size="sm">
                  {settings.normalizeLufs} LUFS
                </Badge>
              </div>
            ) : null}
          </div>
        </Field>
      </section>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Audio analysis
        </h3>

        <div className="divide-y divide-[var(--sonic-border)]">
          <SwitchRow
            title="Analyze downloaded audio automatically"
            description="Estimates tempo and key from the audio itself and fills any field the source did not state. Works locally; nothing is uploaded."
            checked={settings.analyzeOnDownload}
            onChange={(next) => void patchSettings({ analyzeOnDownload: next })}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Gauge className="size-4 shrink-0 text-fg-subtle" />
          <span className="flex-1 text-[12.5px] text-fg-muted">
            Concurrent analyses
            <span className="mt-0.5 block text-[11px] text-fg-subtle">
              Analysis is CPU-bound and runs on a worker thread; 1 is usually right.
            </span>
          </span>
          <Segmented
            value={String(settings.analysisConcurrency)}
            onChange={(next) => void patchSettings({ analysisConcurrency: Number(next) })}
            ariaLabel="Concurrent analyses"
            size="sm"
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' }
            ]}
          />
        </div>

        <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
          A source's own claim always wins over an audio estimate. When the video title, description or
          tags disagree with what was measured, both values are kept and the disagreement is shown in
          the metadata inspector — the estimate only fills fields nothing else supplied.
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Tagging and sidecars
        </h3>

        <div className="divide-y divide-[var(--sonic-border)]">
          <SwitchRow
            title="Embed metadata in the file"
            description="Writes title, producer, tempo, key and genre into the container tags."
            checked={settings.embedTags}
            onChange={(next) => void patchSettings({ embedTags: next })}
          />
          <SwitchRow
            title="Embed cover art"
            description="Uses the source thumbnail as the file's artwork where the format supports it."
            checked={settings.embedThumbnail}
            onChange={(next) => void patchSettings({ embedThumbnail: next })}
          />
          <SwitchRow
            title="Write a .sonic.json sidecar"
            description="Records the source, final metadata, evidence and output fingerprint next to every export."
            checked={settings.writeSidecar}
            onChange={(next) => void patchSettings({ writeSidecar: next })}
          />
          <SwitchRow
            title="Keep sidecars in a .json subfolder"
            description="Keeps the main export folder free of sidecar clutter."
            checked={settings.sidecarInSubfolder}
            disabled={!settings.writeSidecar}
            onChange={(next) => void patchSettings({ sidecarInSubfolder: next })}
          />
          <SwitchRow
            title="Rewrite audio file tags when metadata is corrected"
            description="Not available yet. Corrections update the library and sidecar; re-export to write corrected audio tags."
            checked={false}
            disabled
            onChange={(next) => void patchSettings({ rewriteTagsOnEdit: next })}
          />
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold tracking-[0.1em] text-fg-subtle uppercase">
          Queue behaviour
        </h3>

        <div className="divide-y divide-[var(--sonic-border)]">
          <SwitchRow
            title="Start downloads automatically"
            description="Begin exporting as soon as a pasted link has been inspected, instead of waiting for review."
            checked={settings.autoStart}
            onChange={(next) => void patchSettings({ autoStart: next })}
          />
          <SwitchRow
            title="Skip beats already in the library"
            description="If a link's video is already exported, the job completes without downloading it again."
            checked={settings.skipExisting}
            onChange={(next) => void patchSettings({ skipExisting: next })}
          />
        </div>

        <div className={cn('mt-4 flex items-center gap-3')}>
          <Repeat2 className="size-4 shrink-0 text-fg-subtle" />
          <span className="flex-1 text-[12.5px] text-fg-muted">Concurrent downloads</span>
          <Segmented
            value={String(settings.concurrency)}
            onChange={(next) => void patchSettings({ concurrency: Number(next) })}
            ariaLabel="Concurrent downloads"
            size="sm"
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' }
            ]}
          />
        </div>
      </section>
    </div>
  )
}
