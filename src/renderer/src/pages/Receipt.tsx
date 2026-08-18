import { ArrowLeftRight } from 'lucide-react'
import { planSync } from '@shared/drift'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/app/StatusBadge'
import { DEFAULT_IGNORE, useWorkspace } from '@/store/workspace'

export function ReceiptPage(): React.JSX.Element {
  const { left, right, receipt, comparing, compare, error } = useWorkspace()

  if (!left || !right) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Pick two environments</CardTitle>
            <CardDescription>
              In Workspace, mark one file as A and another as B. You get key names and a class for
              each one: same, changed, missing, extra or blank. Never the values.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const plan = receipt ? planSync(receipt) : []

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Drift receipt</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {left.rel} <ArrowLeftRight className="inline size-3" /> {right.rel}
          </p>
        </div>
        <Button onClick={compare} disabled={comparing}>
          {comparing ? 'Comparing…' : receipt ? 'Compare again' : 'Compare'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Values are compared on this machine as session fingerprints and never shown. Ignored keys:{' '}
        <code>{DEFAULT_IGNORE.join(', ')}</code>
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}

      {receipt && (
        <Tabs defaultValue="receipt" className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="receipt">Receipt</TabsTrigger>
            <TabsTrigger value="plan">Dry-run plan ({plan.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="receipt" className="min-h-0 space-y-3 overflow-auto">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(receipt.counts) as (keyof typeof receipt.counts)[]).map((k) => (
                <Badge key={k} variant="secondary" className="font-mono text-[11px]">
                  {k} {receipt.counts[k]}
                </Badge>
              ))}
              <Badge variant={receipt.clean ? 'default' : 'outline'}>
                {receipt.clean ? 'clean' : 'needs review'}
              </Badge>
            </div>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipt.rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-mono text-xs">{r.key}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
          <TabsContent value="plan" className="min-h-0 overflow-auto">
            <p className="mb-2 text-xs text-muted-foreground">
              Descriptive only. Nothing here writes anywhere. Extra keys on the target are never
              removed automatically.
            </p>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Op</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.map((a) => (
                    <TableRow key={a.key}>
                      <TableCell className="font-mono text-xs">{a.key}</TableCell>
                      <TableCell className="font-mono text-xs uppercase">{a.op}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
