import { Construction } from 'lucide-react'

/**
 * Roadmap surface. Says plainly that nothing here is built, lists what the
 * site promises, and points at what already works today when there is overlap.
 */
export function PlannedPage({
  title,
  blurb,
  points,
  today
}: {
  title: string
  blurb: string
  points: string[]
  today?: string
}): React.JSX.Element {
  return (
    <div className="dotgrid flex h-full items-center justify-center overflow-auto p-8">
      <section className="stagger w-full max-w-xl rounded-xl border border-dashed bg-card p-6">
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-sm border border-warn/30 bg-warn-soft px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-warn uppercase">
          <Construction className="size-3" aria-hidden="true" /> Roadmap · not in this build
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
        <ul className="mt-4 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {points.map((p) => (
            <li key={p} className="flex items-center gap-2 text-muted-foreground">
              <span className="size-1.5 rounded-full bg-lemon-ink/60" aria-hidden="true" />
              {p}
            </li>
          ))}
        </ul>
        {today && (
          <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Works today: </span>
            {today}
          </p>
        )}
      </section>
    </div>
  )
}
