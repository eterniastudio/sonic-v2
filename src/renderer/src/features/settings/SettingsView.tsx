import { useState, type ReactNode } from 'react'
import { HardDrive, Palette, Settings2, SlidersHorizontal, Wand2 } from 'lucide-react'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { AdvancedSection } from './AdvancedSection'
import { AppearanceSection } from './AppearanceSection'
import { EngineSection } from './EngineSection'
import { ExportSection } from './ExportSection'

type Tab = 'appearance' | 'export' | 'engine' | 'advanced'

const SECTIONS: { value: Tab; label: string; icon: ReactNode }[] = [
  { value: 'appearance', label: 'Appearance', icon: <Palette /> },
  { value: 'export', label: 'Export', icon: <Settings2 /> },
  { value: 'engine', label: 'Media engine', icon: <Wand2 /> },
  { value: 'advanced', label: 'Advanced', icon: <SlidersHorizontal /> }
]

/** Focused preferences with a stable category bar and clearly grouped controls. */
export function SettingsView(): ReactNode {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('settings-tab')
    return SECTIONS.some((section) => section.value === saved) ? saved as Tab : 'appearance'
  })

  return (
    <div className="workspace-page h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1040px] pb-8">
        <header className="page-header mb-6 flex-wrap">
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-description">
              Fine-tune your workspace, audio exports, and local media engine.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] text-fg-muted">
            <HardDrive className="size-3 text-fg-subtle" />
            Local preferences
          </div>
        </header>

        <div className="mb-6 border-b border-line pb-4">
          <MagnetTabs
            value={tab}
            onChange={(next) => { setTab(next as Tab); localStorage.setItem('settings-tab', next) }}
            ariaLabel="Settings sections"
            tabs={SECTIONS}
            className="max-w-full [&>button]:px-4 [&>button]:py-2"
          />
        </div>

        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'appearance' ? <AppearanceSection /> : null}
          {tab === 'export' ? <ExportSection /> : null}
          {tab === 'engine' ? <EngineSection /> : null}
          {tab === 'advanced' ? <AdvancedSection /> : null}
        </div>
      </div>
    </div>
  )
}
