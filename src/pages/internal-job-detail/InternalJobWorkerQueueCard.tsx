import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkQueueRecord } from "@/features/quotes/types";
import { formatStatusLabel } from "@/features/quotes/utils";

type InternalJobWorkerQueueCardProps = {
  tasks: WorkQueueRecord[];
};

export function InternalJobWorkerQueueCard({ tasks }: InternalJobWorkerQueueCardProps) {
  return (
    <Card className="border-border bg-accent">
      <CardHeader>
        <CardTitle>Worker queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {tasks.slice(0, 8).map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between rounded-2xl border border-border bg-muted px-4 py-3 text-sm"
          >
            <div>
              <p className="font-medium">{formatStatusLabel(task.task_type)}</p>
              <p className="text-xs text-muted-foreground">{new Date(task.created_at).toLocaleString()}</p>
            </div>
            <Badge variant="secondary" className="border border-border bg-accent text-foreground/80">
              {formatStatusLabel(task.status)}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
