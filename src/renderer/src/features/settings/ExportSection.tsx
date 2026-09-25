import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, FileAudio2, FolderOpen, Gauge, Repeat2 } from 'lucide-react'
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
import { SettingsPanel } from './SettingsPanel'

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
    <div className="space-y-5">
      <SettingsPanel title="Destination" description="A home for every finished beat." bodyClassName="space-y-4">
        <Field label="Export folder" htmlFor="settings-export-folder" hint="Where finished beats are published">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                id="settings-export-folder"
                value={settings.downloadDir}
                readOnly
                className="font-mono text-[11.5px]"
                leading={<FolderOpen />}
              />
            </div>
            <Button variant="secondary" onClick={() => void chooseDownloadDir()}>
              Change
            </Button>
          </div>
        </Field>

        <FolderPreview
          path={settings.downloadDir}
          files={library.slice(0, 12).map((beat) => ({ name: beat.fileName, sizeBytes: beat.sizeBytes }))}
        />
      </SettingsPanel>

      <SettingsPanel title="Naming" description="Keep your exports consistent and easy to find." bodyClassName="space-y-4">
        <Field
          label="File name template"
          htmlFor="settings-naming-template"
          hint={`${TEMPLATE_TOKENS.length} tokens available`}
          note={
            preview?.unknownTokens.length
              ? `Unknown token: ${preview.unknownTokens.join(', ')}`
              : undefined
          }
        >
          <Input
            id="settings-naming-template"
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

        <div className="flex items-center gap-3 rounded-xl border border-line bg-bg/60 p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-fg-muted">
            <FileAudio2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 text-[10px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">Preview</div>
            <div className="font-mono text-[12px] break-all text-fg">
              {preview?.rendered || 'untitled'}.{preset.extension}
            </div>
          </div>
          <Badge size="sm">{preset.extension.toUpperCase()}</Badge>
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
      </SettingsPanel>

      <SettingsPanel title="Default recipe" description="Your starting point for every new download." bodyClassName="space-y-5">
        <div className="grid grid-cols-2 gap-5">
          <Field label="Format for new downloads">
            <Dropdown
              width="trigger"
              className="w-full"
              trigger={({ toggle }) => (
                <Button variant="secondary" className="w-full justify-between" trailing={<ChevronDown />} onClick={toggle}>
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
          note="Leave this off unless your destination asks for a specific loudness target."
        >
          <div className="flex flex-wrap items-center gap-3">
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
                  aria-label="Loudness target"
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
      </SettingsPanel>

      <SettingsPanel title="Audio analysis" description="Discover tempo and key from your audio, directly on this device." bodyClassName="pt-2">
        <div className="divide-y divide-[var(--sonic-border)]">
          <SwitchRow
            title="Analyze downloaded audio automatically"
            description="Estimates tempo and key from the audio itself and fills any field the source did not state. Works locally; nothing is uploaded."
            checked={settings.analyzeOnDownload}
            onChange={(next) => void patchSettings({ analyzeOnDownload: next })}
          />
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-bg/50 p-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-muted"><Gauge className="size-4" /></span>
          <span className="flex-1 text-[12.5px] text-fg-muted">
            Concurrent analyses
            <span className="mt-0.5 block text-[11px] text-fg-subtle">
              One at a time keeps your workspace responsive.
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
      </SettingsPanel>

      <SettingsPanel title="Tagging and sidecars" description="Choose the metadata that travels with your exports." bodyClassName="py-1">
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
      </SettingsPanel>

      <SettingsPanel title="Queue behaviour" description="Control how new links move from review to your library." bodyClassName="pt-2">
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

        <div className={cn('mt-3 flex items-center gap-3 rounded-xl border border-line bg-bg/50 p-4')}>
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-muted"><Repeat2 className="size-4" /></span>
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
      </SettingsPanel>
    </div>
  )
}
