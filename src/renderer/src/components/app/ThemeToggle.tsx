import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { transitionTheme } from '@/lib/theme'

export function ThemeToggle(): React.JSX.Element {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      className="no-drag"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => transitionTheme(setTheme, dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
