import { useMemo, useState, type ReactNode } from 'react'
import { ClipboardPaste, Link2, MousePointerClick, Sparkles, TriangleAlert, X } from 'lucide-react'
import { extractVideoUrls } from '@shared/url'
import { PRESETS } from '@shared/presets'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Input'
import { StatefulButton } from '@/components/aceternity/StatefulButton'
import { Switch } from '@/components/ui/Switch'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { DraggableMarquee } from '@/components/obsidian/DraggableMarquee'
import { toast } from '@/components/ui/Toaster'

/**
 * Link intake.
 *
 * Accepts a single paste of many links, a drag-and-drop of text, or plain
 * typing — and reports exactly what it could and could not read before anything
 * is queued.
 */
export function IntakePanel(): ReactNode {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)

  const addUrls = useApp((state) => state.addUrls)
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)

  const parsed = useMemo(() => extractVideoUrls(text), [text])
  const acceptedCount = parsed.accepted.length
  const preset = PRESETS.find((entry) => entry.id === settings.defaultPresetId) ?? PRESETS[0]

  const submit = async (): Promise<void> => {
    if (acceptedCount === 0) {
      setShakeKey((value) => value + 1)
      return
    }
    await addUrls([text])
    toast({
      kind: 'success',
      title: `Queued ${acceptedCount} link${acceptedCount === 1 ? '' : 's'}`,
      description: settings.autoStart
        ? 'Inspecting and downloading now.'
        : 'Review the metadata, then start the download.'
    })
    setText('')
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const dropped =
      event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    if (dropped) {
      setText((current) => (current.length > 0 ? `${current}\n${dropped}` : dropped))
    }
  }

  return (
    <section className="relative overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Link2 className="size-4 text-accent" />
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">Add beats</h2>
        <span className="flex-1" />
        {acceptedCount > 0 ? (
          <Badge tone="accent" size="sm">
            {acceptedCount} link{acceptedCount === 1 ? '' : 's'} ready
          </Badge>
        ) : null}
      </div>

      <div className="p-4">
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative rounded-[11px] transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
            dragging && 'bg-accent-softer ring-2 ring-[var(--sonic-accent-line)]'
          )}
        >
          <Textarea
            // Remounting on shake replays the error-state transition.
            key={shakeKey}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            rows={4}
            spellCheck={false}
            placeholder={'Paste YouTube beat links — one per line, or all at once.\nhttps://www.youtube.com/watch?v=…'}
            className={cn('pr-3 leading-relaxed', shakeKey > 0 && acceptedCount === 0 && 't-input is-shaking is-error')}
          />

          {dragging ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[11px] bg-surface/85 text-[12.5px] font-medium text-accent">
              Drop links here
            </div>
          ) : null}
        </div>

        {parsed.rejected.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" />
            <span className="text-[11.5px] text-fg-muted">Skipped:</span>
            {parsed.rejected.slice(0, 4).map((token) => (
              <span
                key={token}
                className="max-w-[190px] truncate rounded-[5px] bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-subtle"
                title={token}
              >
                {token}
              </span>
            ))}
            {parsed.rejected.length > 4 ? (
              <span className="text-[11px] text-fg-subtle">+{parsed.rejected.length - 4} more</span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
          <StatefulButton
            onAction={submit}
            disabled={acceptedCount === 0}
            icon={<Sparkles className="size-3.5" />}
            loadingLabel="Queueing…"
            successLabel="Queued"
          >
            Add to queue
          </StatefulButton>

          <Button
            variant="ghost"
            size="md"
            leading={<ClipboardPaste />}
            onClick={() => void ipc.invoke('app:readClipboard').then((value) => value && setText(value)).catch(error => toast({ kind: 'error', title: 'Could not paste', description: String(error) }))}
          >
            Paste
          </Button>

          {text.length > 0 ? (
            <Button variant="ghost" size="md" leading={<X />} onClick={() => setText('')}>
              Clear
            </Button>
          ) : null}

          <span className="flex-1" />

          <div className="flex items-center gap-2.5 rounded-[9px] border border-line bg-surface-2 px-2.5 py-1.5">
            <Switch
              checked={settings.autoStart}
              onChange={(next) => void patchSettings({ autoStart: next })}
              label="Start downloads automatically"
            />
            <span className="text-[12px] text-fg-muted">Auto-start</span>
          </div>

          <Dropdown
            align="end"
            trigger={({ toggle }) => (
              <Button variant="secondary" size="md" onClick={toggle} title="Default export format">
                {preset.label}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Default export format</DropdownLabel>
                {PRESETS.map((entry) => (
                  <DropdownItem
                    key={entry.id}
                    selected={entry.id === settings.defaultPresetId}
                    hint={entry.short}
                    onSelect={async () => {
                      await patchSettings({ defaultPresetId: entry.id })
                      close()
                    }}
                  >
                    {entry.label}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        </div>

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <MousePointerClick className="size-3" />
          Ctrl + Enter adds the queue. Only links you are authorised to download should be used.
        </p>
      </div>

      {/* Drag-to-scrub format strip; also a reminder of what Sonic can emit. */}
      <div className="border-t border-line px-4 py-2.5">
        <DraggableMarquee speed={26} className="select-none">
          <div className="flex items-center gap-2 pr-2">
            {PRESETS.map((entry) => (
              <span
                key={entry.id}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] whitespace-nowrap text-fg-muted"
              >
                <span className="font-medium text-fg">{entry.label}</span>
                <span className="text-fg-subtle">
                  {entry.lossless ? 'lossless' : 'lossy'} · {entry.sizeHint}
                </span>
              </span>
            ))}
          </div>
        </DraggableMarquee>
      </div>
    </section>
  )
}
