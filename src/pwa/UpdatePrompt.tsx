import { useState } from 'react'
import { applyUpdate, dismissUpdate, usePwaState } from './pwa'
import './UpdatePrompt.css'

export function UpdatePrompt() {
  const { updateAvailable } = usePwaState()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState(false)
  if (!updateAvailable) return null

  const refresh = async () => {
    if (!window.confirm('更新會重新整理 App，請先儲存正在編輯的內容。現在更新嗎？')) return
    setUpdating(true)
    setError(false)
    try {
      await applyUpdate()
    } catch {
      setError(true)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="update-prompt" role="status" aria-live="polite">
      <span>{error ? '更新失敗，請再試一次' : '有新版本可用'}</span>
      <button type="button" disabled={updating} onClick={() => { setError(false); dismissUpdate() }}>稍後</button>
      <button type="button" className="update-prompt__go" disabled={updating} onClick={() => void refresh()}>
        {updating ? '更新中…' : '重新整理'}
      </button>
    </div>
  )
}
