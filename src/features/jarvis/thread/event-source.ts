import type { GraphEvent } from '../core/types';

export interface EventSource {
  listen(events: (events: GraphEvent[]) => void, connection: (offline: boolean) => void): () => void;
  retry(): void;
}
/** The shell supplies an owner scoped transport. No table or endpoint assumptions. */
export interface ConversationTransport {
  subscribe(conversationId: string, event: (event: GraphEvent) => void, failed: (failed: boolean) => void): () => void;
  poll(conversationId: string): Promise<GraphEvent[]>;
}
export function createEventSource(transport: ConversationTransport, conversationId: string): EventSource {
  let retry = () => { };
  return {
    retry: () => retry(),
    listen(deliver, connection) {
      let disposed = false, failed = false, pollFailed = false, busy = false, delay = 5000;
      let timer: ReturnType<typeof setTimeout>;
      const seen = new Set<string>();
      const emit = (events: GraphEvent[]) => {
        const fresh = events.filter(e => {
          const key = `${e.runId}:${e.seq}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
        if (fresh.length) deliver(fresh);
      };
      const needsPoll = () => failed || pollFailed || document.hidden;
      const schedule = () => {
        clearTimeout(timer);
        if (!disposed) timer = setTimeout(() => void poll(), delay);
      };
      const poll = async () => {
        if (disposed || busy) return;
        busy = true;
        try {
          const events = await transport.poll(conversationId);
          if (!disposed) { emit(events); connection(false); pollFailed = false; delay = 5000; }
        } catch {
          if (!disposed) { pollFailed = true; connection(true); delay = Math.min(delay * 2, 60000); }
        } finally {
          busy = false;
          if (needsPoll()) schedule();
        }
      };
      retry = () => { clearTimeout(timer); void poll(); };
      const visibility = () => { if (needsPoll()) schedule(); else clearTimeout(timer); };
      const unsubscribe = transport.subscribe(conversationId, e => { if (!disposed) emit([e]); }, down => {
        if (disposed) return;
        failed = down; connection(down || pollFailed);
        if (needsPoll()) schedule(); else clearTimeout(timer);
      });
      document.addEventListener('visibilitychange', visibility);
      void poll();
      return () => {
        disposed = true; clearTimeout(timer); unsubscribe();
        document.removeEventListener('visibilitychange', visibility); retry = () => { };
      };
    },
  };
}
