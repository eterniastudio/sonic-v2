import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
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

export function AppearanceSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)

  return (
    <div>
      <SettingsPanel title="Theme" description="Choose a color scheme.">
        <MagnetTabs
          value={settings.theme}
          onChange={(next) => void patchSettings({ theme: next as ThemeMode })}
          ariaLabel="Theme"
          mode="choices"
          variant="segmented"
          className="!rounded-md !bg-transparent !p-0 [&>button]:!h-8 [&>button]:!rounded-md [&>button]:!px-3 [&>button]:!py-1 [&>.t-tabs-pill]:!top-0 [&>.t-tabs-pill]:!h-8 [&>.t-tabs-pill]:!rounded-md [&>.t-tabs-pill]:!bg-surface-2 [&>.t-tabs-pill]:!shadow-none"
          tabs={[
            { value: 'dark', label: 'Dark', icon: <Moon /> },
            { value: 'light', label: 'Light', icon: <Sun /> },
            { value: 'system', label: 'System', icon: <Monitor /> }
          ]}
        />
      </SettingsPanel>

      <SettingsPanel title="Accent" description="Selected items and focus indicators.">
        <div className="flex flex-wrap gap-1.5">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              aria-label={accent.label}
              aria-pressed={settings.accent === accent.id}
              title={accent.label}
              onClick={() => void patchSettings({ accent: accent.id })}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors',
                settings.accent === accent.id ? 'border-line-strong bg-surface-2 text-fg' : 'border-transparent text-fg-muted hover:bg-surface-2'
              )}
            >
              <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: accent.swatch }} />
              {accent.label}
            </button>
          ))}
        </div>
      </SettingsPanel>

      <SettingsPanel title="Motion preference" description="Control interface animations.">
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
      </SettingsPanel>
    </div>
  )
}
