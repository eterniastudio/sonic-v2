import { useState, type ReactNode } from 'react'
import { Palette, Settings2, SlidersHorizontal, Wand2 } from 'lucide-react'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { AdvancedSection } from './AdvancedSection'
import { AppearanceSection } from './AppearanceSection'
import { EngineSection } from './EngineSection'
import { ExportSection } from './ExportSection'

type Tab = 'appearance' | 'export' | 'engine' | 'advanced'

/** Settings shell: four focused panels instead of one long scroll. */
export function SettingsView(): ReactNode {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('settings-tab') as Tab) || 'appearance')

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mx-auto max-w-3xl space-y-4 pb-6">
        <header className="pt-1">
          <h1 className="text-[17px] font-semibold tracking-tight text-fg">Settings</h1>
          <p className="mt-1 text-[12.5px] text-fg-muted">
            Appearance, export recipes, the media engine, and where Sonic keeps your files.
          </p>
        </header>

        <MagnetTabs
          value={tab}
          onChange={(next) => { setTab(next as Tab); localStorage.setItem('settings-tab', next) }}
          ariaLabel="Settings sections"
          tabs={[
            { value: 'appearance', label: 'Appearance', icon: <Palette /> },
            { value: 'export', label: 'Export', icon: <Settings2 /> },
            { value: 'engine', label: 'Media engine', icon: <Wand2 /> },
            { value: 'advanced', label: 'Advanced', icon: <SlidersHorizontal /> }
          ]}
        />

        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="rounded-[14px] border border-line bg-surface p-5">
          {tab === 'appearance' ? <AppearanceSection /> : null}
          {tab === 'export' ? <ExportSection /> : null}
          {tab === 'engine' ? <EngineSection /> : null}
          {tab === 'advanced' ? <AdvancedSection /> : null}
        </div>
      </div>
    </div>
  )
}
