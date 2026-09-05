import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * "Where do these values come from?" for the Vault source form. Each step maps
 * to one field in AddSourceDialog and to one check in connectVault
 * (src/main/providers/vault/index.ts): nothing here is asked for that the app
 * does not use. Placeholders only; a real token never appears in the UI.
 */
const C = ({ children }: { children: string }): React.JSX.Element => (
  <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">{children}</code>
)

const STEPS: { field: string; body: React.ReactNode }[] = [
  {
    field: 'Address',
    body: (
      <>
        Your Vault URL, the same value as <C>VAULT_ADDR</C> in a terminal where <C>vault status</C>{' '}
        works, or the cluster URL on the HCP portal. It must start with <C>https://</C> (plain{' '}
        <C>http://</C> is accepted only for a Vault Proxy on this machine). Connect refuses a sealed
        or uninitialised Vault.
      </>
    )
  },
  {
    field: 'Namespace',
    body: (
      <>
        Vault Enterprise and HCP only, same as <C>VAULT_NAMESPACE</C>. HCP Vault Dedicated clusters
        use <C>admin</C>. Self-hosted community Vault: leave it empty.
      </>
    )
  },
  {
    field: 'KV v2 path',
    body: (
      <>
        The mount name followed by the path to a secret, as the Vault UI breadcrumb or{' '}
        <C>vault kv list secret/apps</C> shows it, e.g. <C>secret/apps/api</C>. Do not add a{' '}
        <C>data/</C> or <C>metadata/</C> segment. The mount must be KV version 2 (
        <C>vault secrets list -detailed</C> shows <C>version:2</C>). A secret becomes one
        environment; a folder makes each secret inside it an environment.
      </>
    )
  },
  {
    field: 'Token',
    body: (
      <>
        Sign in with <C>vault login</C> and copy the token it prints, use <C>Copy token</C> from the
        user menu in the Vault web UI, or ask your admin for a scoped one (
        <C>vault token create -policy=…</C>). It looks like <C>hvs.••••••••</C>; paste it whole. A
        response-wrapping token works too and is unwrapped once. Avoid root tokens.
      </>
    )
  },
  {
    field: 'AppRole',
    body: (
      <>
        Your admin gives you the Role ID (<C>vault read auth/approle/role/NAME/role-id</C>) and
        mints a Secret ID (<C>vault write -f auth/approle/role/NAME/secret-id</C>). Drift logs in
        once with them, keeps only the resulting token, and discards the Secret ID.
      </>
    )
  },
  {
    field: 'Policy',
    body: (
      <>
        The token needs <C>read</C> on <C>MOUNT/data/PATH</C> and <C>MOUNT/metadata/PATH</C>{' '}
        (history), plus <C>list</C> on <C>MOUNT/metadata/PATH/</C> for a folder. Writes also need{' '}
        <C>create</C> or <C>update</C> on <C>MOUNT/data/PATH</C>; without them Connect still works
        and Drift warns that the source is read-only.
      </>
    )
  },
  {
    field: 'CA certificate',
    body: (
      <>
        Only for a self-signed or private CA: paste the PEM certificate chain, the same file as{' '}
        <C>VAULT_CACERT</C>. It is not a secret. Leave empty for public or HCP certificates.
      </>
    )
  }
]

export const VAULT_GUIDE_LABEL = 'How to find these values'

/** Delay before a hover-opened guide closes, so the pointer can cross into it. */
export const HOVER_CLOSE_MS = 150

export function VaultGuide({ className }: { className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // A click or tap pins the guide open until the next click, Escape or outside tap.
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleId = useId()

  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancel, [])
  const show = (): void => {
    cancel()
    setOpen(true)
  }
  const hideSoon = (): void => {
    if (pinned) return
    cancel()
    timer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        cancel()
        setOpen(o)
        if (!o) setPinned(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={VAULT_GUIDE_LABEL}
          aria-expanded={open}
          aria-pressed={pinned}
          onPointerEnter={(e) => {
            if (e.pointerType !== 'touch') show()
          }}
          onPointerLeave={hideSoon}
          onFocus={show}
          onBlur={hideSoon}
          onClick={(e) => {
            // Radix toggles on click as well; one handler decides.
            e.preventDefault()
            cancel()
            if (pinned) {
              setPinned(false)
              setOpen(false)
            } else {
              setPinned(true)
              setOpen(true)
            }
          }}
          className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-accent aria-pressed:text-foreground',
            className
          )}
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-labelledby={titleId}
        side="bottom"
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        className="max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto p-3 text-xs leading-relaxed"
      >
        <p id={titleId} className="font-medium">
          {VAULT_GUIDE_LABEL}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Connect checks each one in this order, then Drift keeps only what it needs.
        </p>
        <ol className="mt-2 space-y-2">
          {STEPS.map((s, i) => (
            <li key={s.field} className="grid grid-cols-[1.25rem_1fr] gap-x-1.5">
              <span className="font-mono text-[11px] text-muted-foreground" aria-hidden="true">
                {i + 1}.
              </span>
              <div>
                <span className="font-medium">{s.field}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="text-muted-foreground">{s.body}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Tick the keyring box to keep the token in the OS keyring; otherwise it lives in memory for
          this session only. Values are never shown or logged; every write is reviewed first.
        </p>
      </PopoverContent>
    </Popover>
  )
}
