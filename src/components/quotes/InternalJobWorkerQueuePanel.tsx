import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkQueueRecord } from "@/features/quotes/types";
import { formatStatusLabel } from "@/features/quotes/utils";

type InternalJobWorkerQueuePanelProps = {
  workQueue: WorkQueueRecord[];
};

export function InternalJobWorkerQueuePanel({
  workQueue,
}: InternalJobWorkerQueuePanelProps) {
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Worker queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {workQueue.slice(0, 8).map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm"
          >
            <div>
              <p className="font-medium">{formatStatusLabel(task.task_type)}</p>
              <p className="text-xs text-white/50">{new Date(task.created_at).toLocaleString()}</p>
            </div>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
              {formatStatusLabel(task.status)}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
