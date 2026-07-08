import { useCallback, useRef, useState } from 'react'

interface Props {
  /** Called with the pointer delta (px) from drag start; positive = right */
  onResize: (delta: number) => void
  onResizeStart: () => void
}

/**
 * Vertical resize handle, ported from vscode/src/vs/base/browser/ui/sash —
 * a 4px hit area straddling the panel boundary that highlights on hover
 * (after a delay) and while dragging.
 */
export function Sash({ onResize, onResizeStart }: Props) {
  const [active, setActive] = useState(false)
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      dragging.current = true
      setActive(true)
      onResizeStart()

      const onMove = (ev: MouseEvent) => onResize(ev.clientX - startX)
      const onUp = () => {
        dragging.current = false
        setActive(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'ew-resize'
    },
    [onResize, onResizeStart]
  )

  return (
    <div className="sash-container">
      <div className={`monaco-sash vertical ${active ? 'active' : ''}`} onMouseDown={onMouseDown} />
    </div>
  )
}
