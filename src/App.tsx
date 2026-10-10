import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useCategories, usePaymentMethods } from './db/hooks'
import { EditorSheet } from './features/EditorSheet'
import { EntrySheet } from './features/EntrySheet'
import { HomeScreen } from './features/HomeScreen'
import { ListScreen, type ListFilters } from './features/ListScreen'
import { ManagePage, type EditorTarget, type ManageKind } from './features/ManagePage'
import { SettingsPage } from './features/SettingsPage'
import { StatsScreen } from './features/StatsScreen'
import { ymOf, type YearMonth } from './lib/dates'
import { initPwa } from './pwa/pwa'
import { Icon } from './ui/Icon'
import { RefDataProvider } from './ui/refData'
import { ToastProvider } from './ui/Toast'

type Tab = 'home' | 'list' | 'stats'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: '首頁', icon: 'tabHome' },
  { id: 'list', label: '明細', icon: 'tabList' },
  { id: 'stats', label: '統計', icon: 'tabStats' },
]

export function App() {
  const categories = useCategories()
  const payments = usePaymentMethods()
  if (!categories || !payments) return <div className="device" aria-busy="true" />
  return (
    <RefDataProvider categories={categories} payments={payments}>
      <Shell />
    </RefDataProvider>
  )
}

/** Lifts the sheet above the on-screen keyboard (iOS standalone does not resize the layout). */
function useKeyboardInset(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      target.current?.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px')
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [target])
}

function Shell() {
  const deviceRef = useRef<HTMLDivElement | null>(null)
  const homeRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLElement | null>(null)
  const statsRef = useRef<HTMLElement | null>(null)
  const [tab, setTab] = useState<Tab>('home') // D-26: always start on home
  const [month, setMonth] = useState<YearMonth>(() => ymOf(new Date()))
  const [filters, setFilters] = useState<ListFilters>({ q: '', type: 'all', categoryId: null })
  const [entry, setEntry] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manage, setManage] = useState<ManageKind | null>(null)
  const [manageShown, setManageShown] = useState<ManageKind>('category')
  const [editor, setEditor] = useState<EditorTarget | null>(null)

  useKeyboardInset(deviceRef)

  // D-43: only let a new version reload the app when nothing is being edited.
  const busy = useRef(false)
  busy.current = entry.open || editor !== null
  useEffect(() => {
    void initPwa(() => !busy.current)
  }, [])

  const goTab = (t: Tab) => {
    if (t === tab) {
      const el = { home: homeRef, list: listRef, stats: statsRef }[t].current
      el?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setTab(t)
  }

  const openTx = useCallback((id: string) => setEntry({ open: true, id }), [])
  const addTx = useCallback(() => setEntry({ open: true, id: null }), [])
  const closeEntry = useCallback(() => setEntry((e) => ({ ...e, open: false })), [])

  const openManage = (k: ManageKind) => {
    setManageShown(k)
    setManage(k)
  }

  // Escape closes the top-most layer (desktop testing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || entry.open) return
      if (editor) setEditor(null)
      else if (manage) setManage(null)
      else if (settingsOpen) setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entry.open, editor, manage, settingsOpen])

  const pushed = settingsOpen

  return (
    <div ref={deviceRef} className={'device' + (pushed ? ' pushed' : '')}>
      <ToastProvider>
        <div className="top-mask" aria-hidden="true" />
        <div className="main" inert={pushed}>
          <HomeScreen
            active={tab === 'home'}
            scrollRef={homeRef}
            onOpenTx={openTx}
            onAdd={addTx}
            onSeeAll={() => {
              setMonth(ymOf(new Date()))
              setFilters({ q: '', type: 'all', categoryId: null })
              setTab('list')
            }}
            onSettings={() => setSettingsOpen(true)}
          />
          <ListScreen
            active={tab === 'list'}
            month={month}
            onMonth={setMonth}
            filters={filters}
            onFilters={setFilters}
            onOpenTx={openTx}
            onAdd={addTx}
            scrollRef={listRef}
          />
          <StatsScreen
            active={tab === 'stats'}
            scrollRef={statsRef}
            month={month}
            onMonth={setMonth}
            onCategory={(categoryId) => {
              setFilters({ q: '', type: 'all', categoryId })
              setTab('list')
              listRef.current?.scrollTo({ top: 0 })
            }}
          />
        </div>

        <nav className="nav" aria-label="主要導覽" inert={pushed}>
          <div className="tabs">
            {TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'tab' + (tab === t.id ? ' active' : '')}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => goTab(t.id)}
              >
                <Icon name={t.icon} />
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="fab" aria-label="記一筆" onClick={addTx}>
            <Icon name="plus" />
          </button>
        </nav>

        <SettingsPage
          open={settingsOpen}
          covered={manage !== null}
          onBack={() => setSettingsOpen(false)}
          onCategories={() => openManage('category')}
          onPayments={() => openManage('payment')}
        />
        <ManagePage kind={manageShown} open={manage !== null} onBack={() => setManage(null)} onEdit={setEditor} />

        <EntrySheet open={entry.open} editId={entry.id} onClose={closeEntry} />
        <EditorSheet target={editor} onClose={() => setEditor(null)} />
      </ToastProvider>
    </div>
  )
}
