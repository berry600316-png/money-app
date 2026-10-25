import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useCategories, usePaymentMethods } from './db/hooks'
import { EditorSheet } from './features/EditorSheet'
import { EntrySheet, type EntryPrefill } from './features/EntrySheet'
import { PlanPage } from './features/plan/PlanPage'
import { PlanTemplatesPage } from './features/plan/PlanTemplatesPage'
import { recordPlannedExpense } from './db/planRepo'
import { recordDateFor } from './lib/plan'
import type { TxInput } from './db/repo'
import { HomeScreen } from './features/HomeScreen'
import { emptyFilters, ListScreen, type ListFilters } from './features/ListScreen'
import { ManagePage, type EditorTarget, type ManageKind } from './features/ManagePage'
import { SettingsPage } from './features/SettingsPage'
import { StatsScreen } from './features/StatsScreen'
import { fromYmd, sameYm, ymOf, type YearMonth } from './lib/dates'
import { useToday } from './lib/useToday'
import { initPwa } from './pwa/pwa'
import { Icon } from './ui/Icon'
import { usePayslips } from './db/hooks'
import { SALARY_CATEGORY_ID } from './db/defaults'
import { ItemHistoryPage } from './features/salary/ItemHistoryPage'
import { AppLockGate } from './features/lock/LockScreen'
import { PayslipEditor, payslipIdForTransaction, type PayslipEditorTarget } from './features/salary/PayslipEditor'
import { PayslipListPage } from './features/salary/PayslipListPage'
import { PayslipPage } from './features/salary/PayslipPage'
import { currentMonthKey } from './lib/months'
import { defaultNewMonth } from './lib/salaryHistory'
import { StackPage } from './ui/StackPage'
import { CardImportPage } from './features/card/CardImportPage'
import { NoticeTypesPage } from './features/card/NoticeTypesPage'
import { ReconcilePage } from './features/card/ReconcilePage'
import { StatementImportPage } from './features/card/StatementImportPage'
import { ReconProvider } from './ui/reconContext'
import { OverlayContext } from './ui/overlay'
import { RefDataProvider, useRefData } from './ui/refData'
import { ToastProvider } from './ui/Toast'
import { DiscardHost, DiscardProvider, useCloseGuard, useDiscardAsking } from './ui/discard'
import { anyLayerOpen } from './ui/layers'
import { markAppReady } from './ui/Launch'
import { AccountsPage } from './features/accounts/AccountsPage'
import { AccountPage } from './features/accounts/AccountPage'
import type { PaymentMethod } from './db/types'

type Tab = 'home' | 'list' | 'stats'
type Route =
  | { kind: 'payslips' }
  | { kind: 'payslip'; id: string }
  | { kind: 'history'; itemId: string }
  | { kind: 'cardImport' }
  | { kind: 'noticeTypes' }
  | { kind: 'reconcile'; statementId: string | null }
  | { kind: 'statementImport' }
  | { kind: 'plan'; month: string }
  | { kind: 'planTemplates' }
  | { kind: 'accounts' }
  | { kind: 'account'; id: string }

const ROUTE_LABEL: Record<Route['kind'], string> = {
  payslips: '薪資單',
  payslip: '薪資單',
  history: '項目歷史',
  cardImport: '匯入',
  noticeTypes: '通知類型',
  reconcile: '核對',
  statementImport: '帳單',
  plan: '規劃',
  planTemplates: '固定項目',
  accounts: '我的帳戶',
  account: '帳戶',
}

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
    <>
      <RefDataProvider categories={categories} payments={payments}>
        <ReconProvider>
          <DiscardProvider>
            <Shell />
          </DiscardProvider>
        </ReconProvider>
      </RefDataProvider>
      {/* D-146: App 鎖, in front of the app; the app underneath keeps its state (an unsaved entry stays). */}
      <AppLockGate />
    </>
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
  const [filters, setFilters] = useState<ListFilters>(() => emptyFilters())
  const [entry, setEntry] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  // D-109: the entry sheet opened from a planned expense (add + link in one go).
  const [planEntry, setPlanEntry] = useState<{ itemId: string; name: string; prefill: EntryPrefill } | null>(null)
  // D-115: a new entry started from a calendar day.
  const [entryDay, setEntryDay] = useState<string | null>(null)
  // D-123: a transfer or card payment started from the accounts pages or reconciliation.
  const [moveEntry, setMoveEntry] = useState<EntryPrefill | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manage, setManage] = useState<ManageKind | null>(null)
  const [manageShown, setManageShown] = useState<ManageKind>('category')
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [backupRequest, setBackupRequest] = useState(0)
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(null)
  // Salary pages (D-73) live in their own stack: list → payslip → item history.
  const [routes, setRoutes] = useState<{ key: number; route: Route; closing: boolean }[]>([])
  const routeKey = useRef(0)
  const [slipEditor, setSlipEditor] = useState<PayslipEditorTarget | null>(null)
  const payslips = usePayslips()
  const guardEditor = useCloseGuard('editor')
  const guardSlip = useCloseGuard('payslipEditor')
  const asking = useDiscardAsking()

  useKeyboardInset(deviceRef)
  // The home screen has its data: the launch mark may hand over (D-98).
  useEffect(() => markAppReady(), [])

  // Re-render every screen when the date changes; if the user was looking at the
  // month that just ended, move to the new current month.
  const today = useToday()
  const shownCurrent = useRef<YearMonth>(ymOf(new Date()))
  useEffect(() => {
    const cur = ymOf(fromYmd(today))
    const prev = shownCurrent.current
    shownCurrent.current = cur
    if (!sameYm(prev, cur)) setMonth((m) => (sameYm(m, prev) ? cur : m))
  }, [today])

  // D-43: only let a new version reload the app when nothing is being edited.
  const busy = useRef(false)
  busy.current = entry.open || editor !== null || slipEditor !== null
  useEffect(() => {
    void initPwa(() => !busy.current)
  }, [])

  // D-136: no card to record notices to yet: open the 行動支付 whose cards are bound (LINE Pay first).
  const ref = useRefData()
  const bindCards = () => {
    const wallets = ref.payments.filter((p) => (p.type === 'mobile' || p.type === 'other') && p.isActive)
    const wallet = wallets.find((p) => /^LINE\s*Pay$/i.test(p.name.trim())) ?? wallets[0]
    setEditor(wallet ? { kind: 'payment', id: wallet.id } : { kind: 'payment', id: null, newType: 'mobile' })
  }
  const push = useCallback((route: Route) => {
    routeKey.current += 1
    const key = routeKey.current
    setRoutes((rs) => [...rs, { key, route, closing: false }])
  }, [])
  const pop = useCallback(() => {
    setRoutes((rs) => {
      const i = rs.map((r) => r.closing).lastIndexOf(false)
      if (i < 0) return rs
      const key = rs[i].key
      // Slightly longer than the 0.32 s slide-out (D-113).
      window.setTimeout(() => setRoutes((now) => now.filter((r) => r.key !== key)), 340)
      return rs.map((r, j) => (j === i ? { ...r, closing: true } : r))
    })
  }, [])
  const liveRoutes = routes.filter((r) => !r.closing)
  // New payslips never start in a future month; if that month already has one, open it (D-63).
  const newPayslip = (month?: string) => {
    let m = month ?? defaultNewMonth(payslips ?? [])
    if (m > currentMonthKey()) m = currentMonthKey()
    const existing = payslips?.find((s) => s.month === m)
    if (existing) push({ kind: 'payslip', id: existing.id })
    else setSlipEditor({ month: m })
  }

  const goTab = (t: Tab) => {
    if (t === tab) {
      const el = { home: homeRef, list: listRef, stats: statsRef }[t].current
      el?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setTab(t)
  }

  // Income created by a payslip opens that payslip instead of the entry sheet (D-64, D-73).
  const openTx = useCallback(
    (id: string) => {
      payslipIdForTransaction(id).then(
        (slipId) => (slipId ? push({ kind: 'payslip', id: slipId }) : setEntry({ open: true, id })),
        () => setEntry({ open: true, id }),
      )
    },
    [push],
  )
  const addTx = useCallback(() => {
    setPlanEntry(null)
    setEntryDay(null)
    setMoveEntry(null)
    setEntry({ open: true, id: null })
  }, [])
  const addTxOn = useCallback((ymd: string) => {
    setPlanEntry(null)
    setMoveEntry(null)
    setEntryDay(ymd)
    setEntry({ open: true, id: null })
  }, [])
  /** D-123: 互轉 from an account, or 繳卡費 for a card (its 預扣 filled in, D-119). */
  const startMove = useCallback((p: EntryPrefill) => {
    setPlanEntry(null)
    setEntryDay(null)
    setMoveEntry({ type: 'transfer', ...p })
    setEntry({ open: true, id: null })
  }, [])
  const payCard = useCallback(
    (card: PaymentMethod, pending: number) => startMove({ toAccountId: card.id, fromAccountId: card.payFromId, amount: pending > 0 ? pending : undefined }),
    [startMove],
  )
  const closeEntry = useCallback(() => setEntry((e) => ({ ...e, open: false })), [])
  const setRouteMonth = (key: number, month: string) =>
    setRoutes((rs) => rs.map((r) => (r.key === key && r.route.kind === 'plan' ? { ...r, route: { kind: 'plan', month } } : r)))

  const openManage = (k: ManageKind) => {
    setManageShown(k)
    setManage(k)
  }

  // Escape closes the top-most layer (desktop testing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Sheets and dialogs answer Esc themselves (ui/layers); pages only when none is open.
      if (e.key !== 'Escape' || e.defaultPrevented || entry.open || asking || anyLayerOpen()) return
      if (slipEditor) guardSlip(() => setSlipEditor(null))
      else if (editor) guardEditor(() => setEditor(null))
      else if (manage) setManage(null)
      else if (settingsOpen) setSettingsOpen(false)
      else if (liveRoutes.length) pop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entry.open, editor, manage, settingsOpen, slipEditor, liveRoutes.length, pop, asking, guardEditor, guardSlip])

  const pushed = settingsOpen || liveRoutes.length > 0
  // Back label = the page underneath, ignoring pages that are already sliding away.
  const backLabelAt = (i: number) => {
    const below = routes.slice(0, i).filter((r) => !r.closing).pop()
    if (!below) return tab === 'home' ? '首頁' : tab === 'list' ? '明細' : '統計'
    return ROUTE_LABEL[below.route.kind]
  }

  // After importing a statement: leave the import page and show that statement's reconciliation.
  const showStatement = (statementId: string) =>
    setRoutes((rs) => {
      const live = rs.filter((r) => !r.closing)
      const top = live[live.length - 1]
      const below = live[live.length - 2]
      const rest = rs.filter((r) => r !== top)
      if (below && below.route.kind === 'reconcile') return rest.map((r) => (r === below ? { ...r, route: { kind: 'reconcile', statementId } } : r))
      routeKey.current += 1
      return [...rest, { key: routeKey.current, route: { kind: 'reconcile', statementId }, closing: false }]
    })

  return (
    <div ref={deviceRef} className={'device' + (pushed ? ' pushed' : '')}>
      <OverlayContext.Provider value={overlayEl}>
      <ToastProvider>
        <div className="top-mask" aria-hidden="true" />
        <div className="main" inert={pushed}>
          <HomeScreen
            active={tab === 'home'}
            scrollRef={homeRef}
            onOpenTx={openTx}
            onAddOn={addTxOn}
            onSeeDay={(ymd) => {
              // D-115: the list, filtered to that one day.
              setFilters(emptyFilters({ dateMode: 'range', from: ymd, to: ymd }))
              setTab('list')
              listRef.current?.scrollTo({ top: 0 })
            }}
            onSettings={() => setSettingsOpen(true)}
            onBackup={() => {
              setSettingsOpen(true)
              setBackupRequest((n) => n + 1)
            }}
            onPlan={() => push({ kind: 'plan', month: currentMonthKey() })}
            onAccounts={() => push({ kind: 'accounts' })}
            onOpenAccount={(id) => push({ kind: 'account', id })}
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
            onImportCards={() => push({ kind: 'cardImport' })}
            onReconcile={() => push({ kind: 'reconcile', statementId: null })}
          />
          <StatsScreen
            active={tab === 'stats'}
            scrollRef={statsRef}
            month={month}
            onMonth={setMonth}
            onCategory={(categoryId) => {
              if (categoryId === SALARY_CATEGORY_ID) {
                push({ kind: 'payslips' }) // D-73
                return
              }
              setFilters(emptyFilters({ categoryIds: [categoryId] }))
              setTab('list')
              listRef.current?.scrollTo({ top: 0 })
            }}
            onPayslips={() => push({ kind: 'payslips' })}
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
          onSalaryItems={() => openManage('salary')}
          backupRequest={backupRequest}
        />
        <ManagePage kind={manageShown} open={manage !== null} onBack={() => setManage(null)} onEdit={setEditor} />

        {routes.map((r, i) => {
          const covered = routes.slice(i + 1).some((x) => !x.closing)
          const back = backLabelAt(i)
          return (
            <StackPage key={r.key} closing={r.closing} covered={covered} label={ROUTE_LABEL[r.route.kind]}>
              {r.route.kind === 'payslips' && (
                <PayslipListPage
                  backLabel={back}
                  onBack={pop}
                  onOpen={(id) => push({ kind: 'payslip', id })}
                  onNew={(m) => newPayslip(m)}
                  onSeeIncome={() => {
                    setFilters(emptyFilters({ categoryIds: [SALARY_CATEGORY_ID] }))
                    setTab('list')
                    setRoutes([])
                  }}
                />
              )}
              {r.route.kind === 'payslip' && (
                <PayslipPage
                  id={r.route.id}
                  backLabel={back}
                  onBack={pop}
                  onEdit={(id) => setSlipEditor({ payslipId: id })}
                  onHistory={(itemId) => push({ kind: 'history', itemId })}
                />
              )}
              {r.route.kind === 'history' && <ItemHistoryPage itemId={r.route.itemId} backLabel={back} onBack={pop} />}
              {r.route.kind === 'cardImport' && <CardImportPage backLabel={back} onBack={pop} onNoticeTypes={() => push({ kind: 'noticeTypes' })} />}
              {r.route.kind === 'noticeTypes' && <NoticeTypesPage backLabel={back} onBack={pop} onBindCards={bindCards} />}
              {r.route.kind === 'statementImport' && <StatementImportPage backLabel={back} onBack={pop} onSaved={showStatement} />}
              {r.route.kind === 'plan' && (
                <PlanPage
                  month={r.route.month}
                  onMonth={(m) => setRouteMonth(r.key, m)}
                  backLabel={back}
                  onBack={pop}
                  onRecord={(v) => {
                    setEntryDay(null)
                    setMoveEntry(null)
                    setPlanEntry({
                      itemId: v.item.id,
                      name: v.item.name,
                      // D-144: its fixed day, or today.
                      prefill: {
                        amount: v.item.amount,
                        merchant: v.item.name,
                        categoryId: v.item.categoryId,
                        paymentMethodId: v.item.paymentMethodId,
                        date: recordDateFor(v.item),
                      },
                    })
                    setEntry({ open: true, id: null })
                  }}
                  onEditTx={(id) => {
                    setPlanEntry(null)
                    setEntry({ open: true, id })
                  }}
                  onTemplates={() => push({ kind: 'planTemplates' })}
                />
              )}
              {r.route.kind === 'planTemplates' && <PlanTemplatesPage backLabel={back} onBack={pop} />}
              {r.route.kind === 'accounts' && (
                <AccountsPage
                  backLabel={back}
                  onBack={pop}
                  onOpen={(id) => push({ kind: 'account', id })}
                  onTransfer={() => startMove({})}
                  onPayCard={payCard}
                  onAdd={() => setEditor({ kind: 'payment', id: null, newType: 'bank' })}
                />
              )}
              {r.route.kind === 'account' && (
                <AccountPage
                  id={r.route.id}
                  backLabel={back}
                  onBack={pop}
                  onEdit={(id) => setEditor({ kind: 'payment', id })}
                  onOpenTx={openTx}
                  onTransferFrom={(id) => startMove({ fromAccountId: id })}
                  onPayCard={payCard}
                  onOpenAccount={(id) => push({ kind: 'account', id })}
                />
              )}
              {r.route.kind === 'reconcile' && (
                <ReconcilePage
                  key={r.route.statementId ?? 'latest'}
                  statementId={r.route.statementId}
                  backLabel={back}
                  onBack={pop}
                  onImportStatement={() => push({ kind: 'statementImport' })}
                  onEditTx={(id) => setEntry({ open: true, id })}
                  onPayCard={payCard}
                />
              )}
            </StackPage>
          )
        })}

        <EntrySheet
          open={entry.open}
          editId={entry.id}
          prefill={entry.id ? null : planEntry ? planEntry.prefill : moveEntry ? moveEntry : entryDay ? { date: entryDay } : null}
          banner={planEntry && !entry.id ? `儲存後會自動對應「${planEntry.name}」，不會多記一筆。` : null}
          saveNew={planEntry && !entry.id ? (input: TxInput) => recordPlannedExpense(planEntry.itemId, input).then(() => undefined) : null}
          onClose={closeEntry}
          onUsePayslip={() => {
            closeEntry()
            newPayslip()
          }}
        />
        <EditorSheet target={editor} onClose={() => setEditor(null)} />
        <PayslipEditor
          target={slipEditor}
          onClose={() => setSlipEditor(null)}
          onDeleted={(id) => {
            // Leave the deleted payslip's page if it is on top.
            const top = liveRoutes[liveRoutes.length - 1]
            if (top && top.route.kind === 'payslip' && top.route.id === id) pop()
          }}
          onOpenExisting={(id) => {
            setSlipEditor(null)
            push({ kind: 'payslip', id })
          }}
        />
        <div className="overlay-root" ref={setOverlayEl} />
        <DiscardHost />
      </ToastProvider>
      </OverlayContext.Provider>
    </div>
  )
}
