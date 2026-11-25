import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { addReconReason, deleteReconReason, orderReconReasons, readReconReasons, RECON_REASONS_KEY, renameReconReason } from '../../card/reconReasons'
import { useSetting } from '../../db/hooks'
import { MoneyError } from '../../db/repo'
import { useToast } from '../../ui/Toast'

export function ReconReasonPicker({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const reasons = readReconReasons(useSetting<unknown>(RECON_REASONS_KEY, []))
  const toast = useToast()
  const [manage, setManage] = useState(false)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [order, setOrder] = useState<string[]>([])
  const [draggingId, setDraggingId] = useState('')
  const [ordering, setOrdering] = useState(false)
  const orderRef = useRef<string[]>([])
  const dragId = useRef('')
  const orderBusy = useRef(false)
  const ids = reasons.map((r) => r.id).join('|')
  useEffect(() => { orderRef.current = reasons.map((r) => r.id); setOrder(orderRef.current) }, [ids])

  const error = (e: unknown) => toast(e instanceof MoneyError ? e.message : '沒有儲存成功，請再試一次', { kind: 'error' })
  const saveName = async () => {
    try {
      if (editingId) await renameReconReason(editingId, name)
      else onSelect((await addReconReason(name)).id)
      setName('')
      setEditingId('')
    } catch (e) { error(e) }
  }
  const move = (id: string, targetId: string) => {
    const next = [...orderRef.current]
    const from = next.indexOf(id)
    const to = next.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    next.splice(from, 1)
    next.splice(to, 0, id)
    orderRef.current = next
    setOrder(next)
  }
  const onDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (orderBusy.current) return
    dragId.current = id
    setDraggingId(id)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragId.current) return
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-recon-reason-id]')
    if (target?.dataset.reconReasonId) move(dragId.current, target.dataset.reconReasonId)
  }
  const persistOrder = async () => {
    if (orderBusy.current) return
    orderBusy.current = true
    setOrdering(true)
    try { await orderReconReasons([...orderRef.current]) }
    catch (e) { error(e); orderRef.current = reasons.map((r) => r.id); setOrder(orderRef.current) }
    finally { orderBusy.current = false; setOrdering(false) }
  }
  const onUp = () => {
    if (!dragId.current) return
    dragId.current = ''
    setDraggingId('')
    void persistOrder()
  }
  const moveAndSave = (id: string, targetId: string) => {
    if (orderBusy.current) return
    move(id, targetId)
    void persistOrder()
  }
  const sorted = order.map((id) => reasons.find((r) => r.id === id)).filter((r) => r !== undefined)

  return <div className="recon-reasons">
    <div className="recon-reasons-head"><strong>確認原因</strong><button type="button" onClick={() => setManage(!manage)}>{manage ? '完成管理' : '管理選項'}</button></div>
    {!manage ? reasons.length ? <div className="recon-reasons-options">
      {reasons.map((r) => <button type="button" key={r.id} className="recon-reason-option" aria-pressed={selectedId === r.id} onClick={() => onSelect(r.id)}>
        <span>{r.label}</span><span className="recon-reason-check" aria-hidden="true">{selectedId === r.id ? '✓' : ''}</span>
      </button>)}
    </div> : <p className="sheet-msg">尚無原因選項，請先新增。</p> : <>
      <div className="recon-reasons-options">
        {sorted.map((r, index) => <div className={'recon-reason-manage' + (draggingId === r.id ? ' dragging' : '')} key={r.id} data-recon-reason-id={r.id}>
          <button type="button" className="recon-reason-handle" aria-label={`拖曳排序 ${r.label}`} style={{ touchAction: 'none' }}
            disabled={ordering} onPointerDown={(e) => onDown(e, r.id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { dragId.current = ''; setDraggingId(''); orderRef.current = reasons.map((x) => x.id); setOrder(orderRef.current) }}>☰</button>
          <span>{r.label}</span>
          <button type="button" aria-label={`${r.label}往上移`} disabled={ordering || index === 0} onClick={() => moveAndSave(r.id, sorted[index - 1].id)}>↑</button>
          <button type="button" aria-label={`${r.label}往下移`} disabled={ordering || index === sorted.length - 1} onClick={() => moveAndSave(r.id, sorted[index + 1].id)}>↓</button>
          <button type="button" aria-label={`改名 ${r.label}`} onClick={() => { setEditingId(r.id); setName(r.label) }}>改名</button>
          <button type="button" aria-label={`刪除 ${r.label}`} onClick={() => void deleteReconReason(r.id).catch(error)}>刪除</button>
        </div>)}
      </div>
      <div className="recon-reason-editor"><input aria-label="原因名稱" maxLength={80} value={name} placeholder={editingId ? '修改原因' : '新增原因'} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn-secondary" disabled={!name.trim()} onClick={() => void saveName()}>{editingId ? '儲存名稱' : '新增'}</button>
        {editingId && <button type="button" className="btn-quiet" onClick={() => { setEditingId(''); setName('') }}>取消</button>}
      </div>
    </>}
  </div>
}
