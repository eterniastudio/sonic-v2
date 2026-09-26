import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, ClipboardPaste, TriangleAlert, X } from 'lucide-react'
import { extractVideoUrls } from '@shared/url'
import { PRESETS } from '@shared/presets'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { StatefulButton } from '@/components/aceternity/StatefulButton'
import { Switch } from '@/components/ui/Switch'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { toast } from '@/components/ui/Toaster'

/** Link composer with a single queue action and persistent export defaults. */
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
    if (dropped) setText((current) => (current.length > 0 ? `${current}\n${dropped}` : dropped))
  }

  return (
    <section className="shrink-0" aria-labelledby="intake-heading">
      <h2 id="intake-heading" className="sr-only">Add beats</h2>
      <div>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative rounded-[8px] border border-line bg-surface transition-colors focus-within:border-line-strong',
            dragging && 'border-line-strong bg-surface-2'
          )}
        >
          <Textarea
            key={shakeKey}
            aria-label="YouTube beat links"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            rows={2}
            spellCheck={false}
            placeholder="Paste YouTube beat links — one per line, or all at once."
            className={cn(
              'min-h-[54px] rounded-none border-0 bg-transparent px-3 pt-3 pb-1 text-[13px] leading-relaxed focus:bg-transparent focus:shadow-none',
              shakeKey > 0 && acceptedCount === 0 && 't-input is-shaking is-error'
            )}
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <Button
              variant="ghost"
              size="xs"
              leading={<ClipboardPaste />}
              onClick={() => void ipc.invoke('app:readClipboard').then((value) => value && setText(value)).catch(error => toast({ kind: 'error', title: 'Could not paste', description: String(error) }))}
            >
              Paste
            </Button>
            {text.length > 0 ? (
              <Button variant="ghost" size="xs" leading={<X />} onClick={() => setText('')}>Clear</Button>
            ) : null}
            <span className="flex-1" />
            <span className="mr-2 hidden text-[11px] text-fg-subtle min-[1350px]:block" aria-hidden>
              <kbd className="font-sans">Ctrl</kbd> + <kbd className="font-sans">Enter</kbd>
            </span>
            <StatefulButton
              onAction={submit}
              disabled={acceptedCount === 0}
              icon={<ArrowRight className="size-3.5" />}
              loadingLabel="Queueing…"
              successLabel="Queued"
              size="sm"
              className="h-7 rounded-[4px] px-2.5 text-[11.5px] shadow-none"
            >
              Add to queue
            </StatefulButton>
          </div>
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[8px] bg-surface/95 text-[13px] font-medium text-fg">Drop links here</div>
          ) : null}
        </div>

        {parsed.rejected.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="status">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" />
            <span className="text-[11.5px] text-fg-muted">Skipped:</span>
            {parsed.rejected.slice(0, 4).map((token) => (
              <span key={token} className="max-w-[190px] truncate rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-subtle" title={token}>{token}</span>
            ))}
            {parsed.rejected.length > 4 ? <span className="text-[11px] text-fg-subtle">+{parsed.rejected.length - 4} more</span> : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[11.5px] text-fg-subtle">Export as</span>
          <Dropdown
            align="start"
            trigger={({ toggle }) => (
              <Button variant="ghost" size="xs" onClick={toggle} title="Default export format" trailing={<ChevronDown />} className="h-6 px-1.5 text-[11.5px] text-fg-muted">
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
                  >{entry.label}</DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        </div>
        {acceptedCount > 0 ? <span className="text-[11.5px] text-fg-subtle" role="status">{acceptedCount} ready</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11.5px] text-fg-subtle">Auto-start</span>
          <Switch checked={settings.autoStart} onChange={(next) => void patchSettings({ autoStart: next })} label="Start downloads automatically" />
        </div>
      </div>
    </section>
  )
}
