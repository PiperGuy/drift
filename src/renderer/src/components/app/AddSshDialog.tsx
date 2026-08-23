import { useState } from 'react'
import { Loader2, Server } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspace } from '@/store/workspace'

/**
 * Add a remote root. Drift shells out to your own `ssh`, so whatever works in a
 * terminal (aliases, keys, agent, ProxyJump) works here; nothing is stored.
 */
export function AddSshDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const addSsh = useWorkspace((s) => s.addSsh)
  const [host, setHost] = useState('')
  const [path, setPath] = useState('/')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await addSsh(host.trim(), path.trim())
              onClose()
            } catch (err) {
              setError(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err))
            } finally {
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="size-4 text-lemon-ink" /> Add a server over SSH
            </DialogTitle>
            <DialogDescription>
              Uses the <code className="font-mono">ssh</code> on this machine: your config, keys and
              agent apply. Key or agent auth only, no password prompts. The server needs GNU
              coreutils (any Linux VPS).
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <label className="block text-xs">
              <span className="text-muted-foreground">Host</span>
              <Input
                autoFocus
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="deploy@vps.example.com or an ~/.ssh/config alias"
                className="mt-1 h-8 font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">Folder on the server</span>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/srv/apps"
                className="mt-1 h-8 font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="press"
              disabled={busy || !host.trim() || !path.startsWith('/')}
            >
              {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Server />}
              {busy ? 'Connecting' : 'Connect and scan'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
