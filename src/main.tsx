import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/newsreader/latin-400.css'
import '@fontsource/newsreader/latin-500.css'
import './styles/app.css'
import { App } from './App'
import { db } from './db/db'
import { watchTextScale } from './lib/textScale'

/** Shown when IndexedDB cannot be opened (blocked storage, private mode, quota). Nothing is deleted. */
function Fatal({ detail }: { detail?: string }) {
  return (
    <div className="device">
      <div className="empty" style={{ paddingTop: 'calc(var(--sat) + 80px)' }}>
        <strong>無法開啟本機資料</strong>
        你的紀錄沒有被刪除。請完全關閉 Money 後再開一次；
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

watchTextScale()
const root = createRoot(document.getElementById('root')!)

db.open().then(
  () =>
    root.render(
      <StrictMode>
        <Boundary>
          <App />
        </Boundary>
      </StrictMode>,
    ),
  (err: unknown) => root.render(<Fatal detail={err instanceof Error ? err.name : undefined} />),
)
