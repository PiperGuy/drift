import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspace } from '@/store/workspace'

/** Paste a DRIFT-… key. Verified in main against the embedded public key; stored only if valid. */
export function LicenseForm({ onActivated }: { onActivated?: () => void }): React.JSX.Element {
  const setLicense = useWorkspace((s) => s.setLicense)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          setLicense(await window.plumbr.activateLicense(key))
          setKey('')
          // Coming from the lock screen: bring the remembered workspace back.
          void useWorkspace.getState().init()
          onActivated?.()
        } catch (err) {
          setError(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          aria-label="License key"
          placeholder="DRIFT-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="h-8 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-bad">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="sm" className="press" disabled={!key.trim() || busy}>
        <KeyRound /> Activate
      </Button>
    </form>
  )
}
