/**
 * The Drift mark: two offset bars and a dot, on a dark tile. Source of truth is
 * build/brand/icon.svg; this is the same geometry simplified for UI sizes.
 * `draw` plays a one-shot entrance (bars draw on, dot pops).
 */
export function Logo({
  size = 24,
  draw = false
}: {
  size?: number
  draw?: boolean
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={draw ? 'logo-draw' : undefined}
    >
      <rect width="32" height="32" rx="8" fill="#141a00" />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        fill="none"
        stroke="#c8ff4d"
        strokeOpacity="0.3"
      />
      <path
        d="M8 12h13M11.5 20h13"
        pathLength={1}
        stroke="#c8ff4d"
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="8" cy="20" r="1.8" fill="#c8ff4d" />
    </svg>
  )
}
