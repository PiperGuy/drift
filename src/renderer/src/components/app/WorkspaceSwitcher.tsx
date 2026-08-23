import { useState } from 'react'
import { Check, ChevronsUpDown, FolderOpen, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AddSourceDialog } from '@/components/app/AddSourceDialog'
import { useWorkspace } from '@/store/workspace'
import { PRODUCT } from '@shared/product'
import { cn } from '@/lib/utils'

const err = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e)

/**
 * Sources: a named folder or server the app is pointed at. One is active at a
 * time; switching swaps what is scanned and compared. Nothing on disk changes.
 * (Each source is a workspace row with one root underneath.)
 */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { workspaces, workspace, switchWorkspace, deleteWorkspace } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'new' | 'edit' | null>(null)
  const current = workspaces.find((w) => w.id === workspace)
  const Icon = current?.path?.startsWith('ssh://') ? Server : FolderOpen

  const remove = async (): Promise<void> => {
    if (!current) return
    if (
      !window.confirm(
        `Remove "${current.name}"? ${PRODUCT} stops reading it. Files on disk are untouched.`
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
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Source: ${current?.name ?? '…'}`}
            title="Switch source"
            className={cn(
              'no-drag press flex items-center gap-1.5 rounded-md text-left transition-colors duration-(--duration-fast) hover:bg-sidebar-accent',
              collapsed ? 'mx-auto size-8 justify-center' : 'mx-2 h-7 px-2'
            )}
          >
            {collapsed ? (
              <Icon className="size-4 text-lemon-ink" aria-hidden="true" />
            ) : (
              <>
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {current?.name ?? '…'}
                </span>
                <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden="true" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-[10px] tracking-widest text-muted-foreground uppercase">
            Sources
          </DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => w.id !== workspace && void switchWorkspace(w.id)}
            >
              <Check
                className={cn('size-3.5', w.id === workspace ? 'text-lemon-ink' : 'invisible')}
              />
              {w.path?.startsWith('ssh://') ? (
                <Server className="size-3.5 text-muted-foreground" />
              ) : (
                <FolderOpen className="size-3.5 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog('new')}>
            <Plus className="size-3.5" /> Add source…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('edit')} disabled={!current}>
            <Pencil className="size-3.5" /> Update source…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void remove()}
            disabled={!current || workspaces.length <= 1}
            variant="destructive"
          >
            <Trash2 className="size-3.5" /> Remove source
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog && <AddSourceDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  )
}
