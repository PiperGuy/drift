import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

/** Placeholder for features on the README todo list. Replace with the real page when it lands. */
export function PlannedPage({
  title,
  blurb,
  points
}: {
  title: string
  blurb: string
  points: string[]
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{title}</CardTitle>
            <Badge variant="outline">planned</Badge>
          </div>
          <CardDescription>{blurb}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
