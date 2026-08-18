import { FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function WorkspacePage(): React.JSX.Element {
  const { root, scan, scanning, error, grant, rescan, left, right, pick } = useWorkspace()

  if (!root) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Grant a workspace root</CardTitle>
            <CardDescription>
              Point Plumbr Env at a folder. It finds every <code>.env*</code> inside, groups them by
              Git project, and leaves each file exactly where it is. Discovery reads metadata only.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={grant}>
              <FolderOpen /> Choose folder
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Workspace</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{root}</p>
        </div>
        <Button variant="outline" size="sm" onClick={rescan} disabled={scanning}>
          <RefreshCw className={cn(scanning && 'animate-spin')} /> Rescan
        </Button>
        <Button variant="outline" size="sm" onClick={grant}>
          <FolderOpen /> Change root
        </Button>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}

      {scanning && !scan ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : scan ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary">{scan.files.length} .env* files</Badge>
            <Badge variant="secondary">{scan.projects.length} Git projects</Badge>
            <Badge variant="secondary">
              {scan.scannedDirs} folders in {scan.durationMs} ms
            </Badge>
            <Badge variant="outline">0 files moved · 0 files copied</Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Git project</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-40 text-right">Compare</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.files.map((f) => {
                  const isL = left?.path === f.path
                  const isR = right?.path === f.path
                  return (
                    <TableRow key={f.path} className={cn((isL || isR) && 'bg-primary/5')}>
                      <TableCell className="font-mono text-xs">{f.rel}</TableCell>
                      <TableCell>
                        {f.project ? (
                          <Badge variant="outline" className="font-mono text-[11px]">
                            git · {f.project}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">ungrouped</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(f.modifiedAt)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {fmtSize(f.size)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          <Button
                            size="xs"
                            variant={isL ? 'default' : 'ghost'}
                            onClick={() => pick('left', f)}
                          >
                            A
                          </Button>
                          <Button
                            size="xs"
                            variant={isR ? 'default' : 'ghost'}
                            onClick={() => pick('right', f)}
                          >
                            B
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      ) : null}
    </div>
  )
}
