import { useEffect, useRef } from 'react'

/**
 * One-shot ambient canvas for onboarding: a quiet field of lemon dots that
 * brightens under the pointer. Purely decorative,
 * reads its colours from the live CSS tokens so it follows light/dark, and
 * renders a single static frame under prefers-reduced-motion.
 *
 * Entrance (one-shot, ~1.6s): dots grow in, rippling out from the centre, while a
 * lemon scan beam sweeps top to bottom once and lights the dots it passes. The beam is the product in one gesture:
 * a workspace being read, nothing being moved.
 */
export function Lattice({ className }: { className?: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    // jsdom and headless contexts have no 2D canvas; the hero reads fine without it.
    if (!canvas || !ctx || typeof ResizeObserver === 'undefined') return

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const CELL = 24
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

    const INTRO = 1.1 // seconds for a dash to settle
    const BEAM = 1.6 // seconds for the beam to cross
    const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)

    const draw = (now: number): void => {
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = ink
      const cols = Math.ceil(w / CELL) + 1
      const rows = Math.ceil(h / CELL) + 1
      const maxD = Math.hypot(w, h) / 2
      const beamY = reduce || t > BEAM ? -1e4 : (t / BEAM) * (h + 80) - 40
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const r = seed(i, j)
          const cx = i * CELL
          const cy = j * CELL
          // Entrance: fade and grow in, rippling out from the centre.
          const delay = reduce ? 0 : (Math.hypot(cx - w / 2, cy - h / 2) / maxD) * 0.5
          const p = reduce ? 1 : easeOut(Math.min(1, Math.max(0, (t - delay) / INTRO)))
          // Slow breathing, phase-offset per dot. Frozen under reduced motion.
          const breathe = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.6 + r * Math.PI * 2)
          // Pointer and beam lift nearby dots: brighter and larger.
          const near = Math.max(0, 1 - Math.hypot(cx - pointer.x, cy - pointer.y) / 140)
          const lit = Math.max(0, 1 - Math.abs(cy - beamY) / 40)
          const lift = Math.max(near, lit)
          const radius = (1 + 0.4 * breathe + lift * 1.6) * p
          const alpha = Math.min(1, ((0.14 + 0.12 * breathe) * gain + lift * 0.7) * p)
          ctx.globalAlpha = alpha
          ctx.beginPath()
          ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      if (beamY > -1e3) {
        // The beam itself: a hairline with a soft halo.
        const g = ctx.createLinearGradient(0, beamY - 40, 0, beamY + 40)
        g.addColorStop(0, 'transparent')
        g.addColorStop(0.5, ink)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.12 * gain
        ctx.fillStyle = g
        ctx.fillRect(0, beamY - 40, w, 80)
        ctx.globalAlpha = 0.6
        ctx.fillStyle = ink
        ctx.fillRect(0, beamY, w, 1)
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
