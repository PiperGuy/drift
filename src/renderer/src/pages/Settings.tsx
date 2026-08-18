import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/channels'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTheme } from 'next-themes'

export function SettingsPage(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const { resolvedTheme, setTheme } = useTheme()
  useEffect(() => {
    window.plumbr.appInfo().then(setInfo)
  }, [])
  return (
    <div className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Switch
            id="dark"
            checked={resolvedTheme === 'dark'}
            onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')}
          />
          <Label htmlFor="dark">Dark mode</Label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
          <CardDescription>Plumbr Env {info?.version ?? '…'}</CardDescription>
        </CardHeader>
        <CardContent className="font-mono text-xs text-muted-foreground">
          {info &&
            `${info.platform} · Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`}
        </CardContent>
      </Card>
    </div>
  )
}
