/** The "D" mark from theplumbr.com: dark tile, lemon stroke and bars. */
export function Logo({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#141a00" />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        fill="none"
        stroke="#c8ff4d"
        strokeOpacity="0.35"
      />
      <path
        d="M8 10h16M8 16h9M8 22h16"
        stroke="#c8ff4d"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="22" cy="16" r="2.2" fill="#c8ff4d" />
    </svg>
  )
}
