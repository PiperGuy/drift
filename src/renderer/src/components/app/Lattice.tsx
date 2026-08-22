import { useEffect, useRef } from 'react'

/**
 * One-shot ambient canvas for onboarding: a lattice of redacted "key dashes" in
 * the brand lemon that drifts under the pointer and settles. Purely decorative,
 * reads its colours from the live CSS tokens so it follows light/dark, and
 * renders a single static frame under prefers-reduced-motion.
 */
export function Lattice({ className }: { className?: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    // jsdom and headless contexts have no 2D canvas; the hero reads fine without it.
    if (!canvas || !ctx || typeof ResizeObserver === 'undefined') return

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const CELL = 28
    const DASH = 12
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let t0 = performance.now()
    let ink = '#c8ff4d'
    // Dark olive on near-white needs more alpha than lemon on near-black to read the same.
    let gain = 1
    const pointer = { x: -1e4, y: -1e4 }

    // Per-cell phase and width so the field never reads as a grid of clones.
    const seed = (i: number, j: number): number => {
      const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
      return s - Math.floor(s)
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ink = getComputedStyle(canvas).getPropertyValue('--lemon-ink').trim() || ink
      gain = document.documentElement.classList.contains('dark') ? 1 : 1.6
      draw(performance.now())
    }

    const draw = (now: number): void => {
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = ink
      ctx.lineCap = 'round'
      ctx.lineWidth = 2
      const cols = Math.ceil(w / CELL) + 1
      const rows = Math.ceil(h / CELL) + 1
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const r = seed(i, j)
          const cx = i * CELL
          const cy = j * CELL
          // Gentle breathing, phase-offset per cell. Frozen at t=0 under reduced motion.
          const breathe = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.8 + r * Math.PI * 2)
          // Pointer lifts nearby dashes: brighter and wider within ~140px.
          const dx = cx - pointer.x
          const dy = cy - pointer.y
          const near = Math.max(0, 1 - Math.hypot(dx, dy) / 140)
          const len = DASH * (0.35 + 0.65 * r) * (1 + near * 0.6)
          const alpha = Math.min(1, (0.1 + 0.16 * breathe * r) * gain + near * 0.5)
          ctx.globalAlpha = alpha
          ctx.beginPath()
          ctx.moveTo(cx - len / 2, cy)
          ctx.lineTo(cx + len / 2, cy)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
    }

    const loop = (now: number): void => {
      draw(now)
      raf = requestAnimationFrame(loop)
    }

    const onMove = (e: PointerEvent): void => {
      const b = canvas.getBoundingClientRect()
      pointer.x = e.clientX - b.left
      pointer.y = e.clientY - b.top
      if (reduce) draw(performance.now())
    }
    const onLeave = (): void => {
      pointer.x = pointer.y = -1e4
      if (reduce) draw(performance.now())
    }
    // Pause when the window is hidden; resume with the clock rebased so nothing jumps.
    const onVis = (): void => {
      if (reduce) return
      if (document.hidden) cancelAnimationFrame(raf)
      else {
        t0 = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const parent = canvas.parentElement ?? canvas
    parent.addEventListener('pointermove', onMove)
    parent.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVis)
    // Theme flips swap the token; repaint with the new ink.
    const mo = new MutationObserver(resize)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    resize()
    if (!reduce) raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      parent.removeEventListener('pointermove', onMove)
      parent.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return <canvas ref={ref} aria-hidden="true" className={className} />
}
