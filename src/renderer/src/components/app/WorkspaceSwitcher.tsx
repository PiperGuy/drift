import { useState } from 'react'
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const err = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e)

/**
 * Workspaces are named sets of roots (folders and servers). Switching swaps the
 * granted roots, the scan and the current comparison; nothing on disk changes.
 */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const {
    workspaces,
    workspace,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace
  } = useWorkspace()
  const [open, setOpen] = useState(false)
  const current = workspaces.find((w) => w.id === workspace)

  const create = async (): Promise<void> => {
    const name = window.prompt('Name the new workspace', '')?.trim()
    if (!name) return
    try {
      await createWorkspace(name)
    } catch (e) {
      toast.error(err(e))
    }
  }
  const rename = async (): Promise<void> => {
    if (!current) return
    const name = window.prompt('Rename workspace', current.name)?.trim()
    if (!name || name === current.name) return
    try {
      await renameWorkspace(current.id, name)
    } catch (e) {
      toast.error(err(e))
    }
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    if (
      !window.confirm(
        `Delete workspace "${current.name}"? Its ${current.roots} root${current.roots === 1 ? '' : 's'} stop being read. Files are untouched.`
      )
    )
      return
    try {
      await deleteWorkspace(current.id)
    } catch (e) {
      toast.error(err(e))
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Workspace: ${current?.name ?? '…'}`}
          title="Switch workspace"
          className={cn(
            'no-drag press flex items-center gap-1.5 rounded-md text-left transition-colors duration-(--duration-fast) hover:bg-sidebar-accent',
            collapsed ? 'mx-auto size-8 justify-center' : 'mx-2 h-7 px-2'
          )}
        >
          {collapsed ? (
            <span className="font-mono text-[11px] font-semibold text-lemon-ink">
              {(current?.name ?? '?').slice(0, 2).toUpperCase()}
            </span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {current?.name ?? '…'}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {current?.roots ?? 0}
              </span>
              <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden="true" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[10px] tracking-widest text-muted-foreground uppercase">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onSelect={() => w.id !== workspace && void switchWorkspace(w.id)}
          >
            <Check
              className={cn('size-3.5', w.id === workspace ? 'text-lemon-ink' : 'invisible')}
            />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {w.roots} root{w.roots === 1 ? '' : 's'}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void create()}>
          <Plus className="size-3.5" /> New workspace…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void rename()} disabled={!current}>
          <Pencil className="size-3.5" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void remove()}
          disabled={!current || workspaces.length <= 1}
          variant="destructive"
        >
          <Trash2 className="size-3.5" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
