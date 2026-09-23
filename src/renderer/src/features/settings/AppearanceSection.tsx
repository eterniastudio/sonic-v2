import type { ReactNode } from 'react'
import type { AccentId, ReduceMotionPreference, ThemeMode } from '@shared/domain'
import { cn } from '@/lib/cn'
import { useApp } from '@/store/app'
import { Segmented } from '@/components/ui/Segmented'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { Field } from '@/components/ui/Input'

const ACCENTS: { id: AccentId; label: string; swatch: string }[] = [
  { id: 'violet', label: 'Violet', swatch: '#7c5cff' },
  { id: 'cyan', label: 'Cyan', swatch: '#06b6d4' },
  { id: 'emerald', label: 'Emerald', swatch: '#10b981' },
  { id: 'amber', label: 'Amber', swatch: '#f59e0b' },
  { id: 'rose', label: 'Rose', swatch: '#f43f5e' }
]

/** Small mock window so theme + accent changes are visible before committing. */
function ThemePreview(): ReactNode {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-bg">
      <div className="flex h-7 items-center gap-1.5 border-b border-line bg-surface/70 px-2.5">
        <span className="size-2 rounded-full bg-danger/70" />
        <span className="size-2 rounded-full bg-warning/70" />
        <span className="size-2 rounded-full bg-success/70" />
        <span className="ml-2 h-2 w-20 rounded-full bg-surface-3" />
      </div>
      <div className="flex gap-2 p-2.5">
        <div className="w-14 space-y-1.5">
          <span className="block h-2 rounded-full bg-accent" />
          <span className="block h-2 w-4/5 rounded-full bg-surface-3" />
          <span className="block h-2 w-3/5 rounded-full bg-surface-3" />
        </div>
        <div className="flex-1 space-y-1.5">
          <span className="block h-2.5 w-1/3 rounded-full bg-accent" />
          <span className="block h-2 rounded-full bg-surface-3" />
          <span className="block h-2 w-5/6 rounded-full bg-surface-3" />
          <span className="mt-2 block h-5 w-16 rounded-[6px] bg-accent" />
        </div>
      </div>
    </div>
  )
}

export function AppearanceSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)

  return (
    <div className="space-y-6">
      <Field label="Theme" hint="Dark is the default; light is a full peer.">
        <MagnetTabs
          value={settings.theme}
          onChange={(next) => void patchSettings({ theme: next as ThemeMode })}
          ariaLabel="Theme"
          mode="choices"
          variant="segmented"
          tabs={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' }
          ]}
        />
      </Field>

      <Field label="Accent" hint="Drives buttons, focus rings and highlights.">
        <div className="flex flex-wrap items-center gap-2">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              aria-label={accent.label}
              title={accent.label}
              onClick={() => void patchSettings({ accent: accent.id })}
              className={cn(
                'grid size-8 place-items-center rounded-full border transition-[border-color,transform]',
                'duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] hover:scale-105',
                settings.accent === accent.id ? 'border-fg' : 'border-line'
              )}
            >
              <span
                className="size-5 rounded-full"
                style={{ backgroundColor: accent.swatch, boxShadow: `0 0 12px ${accent.swatch}66` }}
              />
            </button>
          ))}
        </div>
      </Field>

      <div>
        <div className="mb-2 text-[12px] font-medium text-fg-muted">Preview</div>
        <ThemePreview />
      </div>

      <Field
        label="Motion preference"
        hint="Applies to every transition in the app"
        note="Every transitions.dev snippet ships a prefers-reduced-motion guard, so the OS setting is always honoured."
      >
        <Segmented
          value={settings.reduceMotion}
          onChange={(next: ReduceMotionPreference) => void patchSettings({ reduceMotion: next })}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'on', label: 'Always reduce' },
            { value: 'off', label: 'Always animate' }
          ]}
          size="sm"
        />
      </Field>
    </div>
  )
}
