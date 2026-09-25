import { type CSSProperties, type ReactNode } from 'react'
import { Check, Music2 } from 'lucide-react'
import type { AccentId, ReduceMotionPreference, ThemeMode } from '@shared/domain'
import { cn } from '@/lib/cn'
import { useApp } from '@/store/app'
import { Segmented } from '@/components/ui/Segmented'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { SettingsPanel } from './SettingsPanel'

const ACCENTS: { id: AccentId; label: string; swatch: string }[] = [
  { id: 'violet', label: 'Violet', swatch: 'var(--sonic-choice-violet)' },
  { id: 'cyan', label: 'Cyan', swatch: 'var(--sonic-choice-cyan)' },
  { id: 'emerald', label: 'Emerald', swatch: 'var(--sonic-choice-emerald)' },
  { id: 'amber', label: 'Amber', swatch: 'var(--sonic-choice-amber)' },
  { id: 'rose', label: 'Rose', swatch: 'var(--sonic-choice-rose)' }
]

const THEMES = [
  { id: 'dark' as const, label: 'Dark' },
  { id: 'light' as const, label: 'Light' },
  { id: 'system' as const, label: 'System' }
]

const PREVIEW_STYLES: Record<ThemeMode, CSSProperties & Record<`--${string}`, string>> = {
  dark: { '--preview-bg': 'var(--sonic-preview-dark-bg)', '--preview-surface': 'var(--sonic-preview-dark-surface)', '--preview-line': 'var(--sonic-preview-dark-line)', '--preview-muted': 'var(--sonic-preview-dark-muted)' },
  light: { '--preview-bg': 'var(--sonic-preview-light-bg)', '--preview-surface': 'var(--sonic-preview-light-surface)', '--preview-line': 'var(--sonic-preview-light-line)', '--preview-muted': 'var(--sonic-preview-light-muted)' },
  system: { '--preview-bg': 'var(--sonic-preview-light-bg)', '--preview-surface': 'var(--sonic-preview-dark-surface)', '--preview-line': 'var(--sonic-preview-dark-line)', '--preview-muted': 'var(--sonic-preview-light-muted)' }
}

/** Miniature interface swatches show the difference before a theme is selected. */
function ThemeSwatch({ theme }: { theme: ThemeMode }): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="flex h-[82px] overflow-hidden rounded-lg border border-line bg-[var(--preview-bg)]"
      style={PREVIEW_STYLES[theme]}
    >
      <div className="w-[28%] shrink-0 space-y-2 border-r border-[var(--preview-line)] bg-[var(--preview-surface)] px-2 py-3">
        <span className="mb-3 block h-2 w-2 rounded-full bg-accent" />
        <span className="block h-1 w-full rounded-full bg-[var(--preview-muted)] opacity-60" />
        <span className="block h-1 w-2/3 rounded-full bg-[var(--preview-muted)] opacity-35" />
        <span className="block h-1 w-4/5 rounded-full bg-[var(--preview-muted)] opacity-35" />
      </div>
      <div className="min-w-0 flex-1 p-3">
        <span className="mb-3 block h-1.5 w-1/2 rounded-full bg-[var(--preview-muted)]" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="mb-1.5 flex items-center gap-1.5">
            <span className={cn('size-3 rounded-[3px]', row === 0 ? 'bg-accent/65' : 'bg-[var(--preview-muted)] opacity-30')} />
            <span className="block h-1 flex-1 rounded-full bg-[var(--preview-muted)] opacity-35" />
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspacePreview(): ReactNode {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg" aria-hidden="true">
      <div className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[15px] font-semibold tracking-tight text-fg">Library</p>
          <span className="rounded-md bg-accent px-2 py-1 text-[9px] font-medium text-accent-fg">Add music</span>
        </div>
        <div className="mb-3 flex gap-2">
          <span className="h-5 w-14 rounded-md border border-[var(--sonic-accent-line)] bg-accent/10" />
          <span className="h-5 w-10 rounded-md border border-line bg-surface" />
          <span className="h-5 flex-1 rounded-md border border-line bg-surface" />
        </div>
        {[0, 1, 2].map((row) => (
          <div key={row} className={cn('flex items-center gap-2.5 border-b border-line px-2 py-3', row === 0 && 'rounded-t-lg bg-accent/5')}>
            <span className={cn('grid size-8 place-items-center rounded-md', row === 0 ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-fg-subtle')}>
              <Music2 className="size-3.5" />
            </span>
            <div className="flex-1 space-y-1.5">
              <span className="block h-1.5 w-3/4 rounded-full bg-fg/20" />
              <span className="block h-1 w-1/2 rounded-full bg-fg/10" />
            </div>
            <span className="h-1 w-5 rounded-full bg-fg/10" />
          </div>
        ))}
        <div className="mt-4 flex h-8 items-center justify-center gap-[3px]">
          {[5, 8, 14, 10, 22, 16, 27, 18, 12, 20, 28, 15, 10, 19, 25, 14, 21, 12, 7, 15, 9, 5].map((height, index) => (
            <span key={index} className={cn('w-[3px] rounded-full', index < 12 ? 'bg-accent/70' : 'bg-fg/15')} style={{ height }} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function AppearanceSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)

  return (
    <div className="grid items-start gap-5 min-[1250px]:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-5">
        <SettingsPanel title="Theme" description="Set the tone for your workspace. Follow your system or choose a look.">
          <MagnetTabs
            value={settings.theme}
            onChange={(next) => void patchSettings({ theme: next as ThemeMode })}
            ariaLabel="Theme"
            mode="choices"
            variant="segmented"
            className="flex w-full !rounded-xl !p-1.5 [&>button]:!h-auto [&>button]:min-w-0 [&>button]:flex-1 [&>button]:flex-col [&>button]:gap-2 [&>button]:!rounded-lg [&>button]:!p-2 [&>button>span:first-child]:w-full [&>.t-tabs-pill]:!top-1.5 [&>.t-tabs-pill]:!bottom-1.5 [&>.t-tabs-pill]:!h-auto [&>.t-tabs-pill]:!rounded-lg"
            tabs={THEMES.map((theme) => ({ value: theme.id, label: theme.label, icon: <ThemeSwatch theme={theme.id} /> }))}
          />
        </SettingsPanel>

        <SettingsPanel title="Accent" description="A personal touch for buttons, focus rings, and selected items.">
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                aria-label={accent.label}
                aria-pressed={settings.accent === accent.id}
                title={accent.label}
                onClick={() => void patchSettings({ accent: accent.id })}
                className={cn(
                  'flex min-w-[70px] flex-1 flex-col items-center gap-2 rounded-xl border px-2 py-3 text-[11px] transition-colors',
                  settings.accent === accent.id ? 'border-line-strong bg-surface-2 text-fg' : 'border-transparent text-fg-muted hover:bg-surface-2'
                )}
              >
                <span className="grid size-7 place-items-center rounded-full border border-black/10" style={{ backgroundColor: accent.swatch }}>
                  {settings.accent === accent.id ? <Check className="size-3.5 text-accent-fg" /> : null}
                </span>
                {accent.label}
              </button>
            ))}
          </div>
        </SettingsPanel>

        <SettingsPanel title="Motion preference" description="Choose how transitions and animations move throughout Sonic.">
          <Segmented
            value={settings.reduceMotion}
            onChange={(next: ReduceMotionPreference) => void patchSettings({ reduceMotion: next })}
            ariaLabel="Motion preference"
            options={[
              { value: 'system', label: 'Follow system' },
              { value: 'on', label: 'Always reduce' },
              { value: 'off', label: 'Always animate' }
            ]}
            size="sm"
          />
          <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
            Choose Follow system to use your device&apos;s accessibility setting.
          </p>
        </SettingsPanel>
      </div>

      <aside className="studio-panel p-5 min-[1250px]:sticky min-[1250px]:top-0">
        <div className="mb-4">
          <h3 className="text-[13px] font-semibold text-fg">Preview</h3>
          <p className="mt-1 text-[12px] text-fg-muted">Your workspace, in your style.</p>
        </div>
        <WorkspacePreview />
        <div className="mt-4 flex items-center justify-between text-[11px]">
          <span className="text-fg-subtle">Current accent</span>
          <span className="flex items-center gap-1.5 font-medium text-fg-muted">
            <span className="size-2 rounded-full bg-accent" />
            {ACCENTS.find((accent) => accent.id === settings.accent)?.label}
          </span>
        </div>
      </aside>
    </div>
  )
}
