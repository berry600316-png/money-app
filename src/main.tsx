import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/oswald/latin-400.css'
import '@fontsource/oswald/latin-500.css'
import './styles/app.css'
import { App } from './App'
import { db } from './db/db'
import { watchTextScale } from './lib/textScale'
import { Launch, markAppReady } from './ui/Launch'

/** Shown when IndexedDB cannot be opened (blocked storage, private mode, quota). Nothing is deleted. */
function Fatal({ detail }: { detail?: string }) {
  return (
    <div className="device">
      <div className="empty" style={{ paddingTop: 'calc(var(--sat) + 80px)' }}>
        <strong>無法開啟本機資料</strong>
        你的紀錄沒有被刪除。請完全關閉 Cai Jie 後再開一次；
        <br />
        如果仍然出現這個畫面，請確認 iPhone 儲存空間是否足夠。
        {detail && <p style={{ fontSize: '0.75rem', marginTop: 16 }}>{detail}</p>}
        <button type="button" className="btn-soft" onClick={() => location.reload()}>
          重新載入
        </button>
      </div>
    </div>
  )
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? <Fatal detail={this.state.error.name} /> : this.props.children
  }
}

/** The launch mark (D-98) stays mounted while the database opens and the app takes over underneath. */
function Root() {
  const [state, setState] = useState<{ kind: 'opening' } | { kind: 'ok' } | { kind: 'error'; detail?: string }>({ kind: 'opening' })
  useEffect(() => {
    db.open().then(
      () => setState({ kind: 'ok' }),
      (err: unknown) => {
        markAppReady() // nothing to wait for: show the message
        setState({ kind: 'error', detail: err instanceof Error ? err.name : undefined })
      },
    )
  }, [])
  return (
    <>
      {state.kind === 'ok' && (
        <Boundary>
          <App />
        </Boundary>
      )}
      {state.kind === 'error' && <Fatal detail={state.detail} />}
      <Launch />
    </>
  )
}

watchTextScale()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
