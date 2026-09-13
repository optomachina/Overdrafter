import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export class ReadReply { constructor(text,receivedBytes) { this.text=text; this.receivedBytes=receivedBytes; } }
export class ReadStop extends Error { constructor(code) { super(code); this.code = code; } }
/** One serial acquisition budget. Failure poisons it, including unresolved cancellation. */
export function createBudget({ maxCalls, maxBytes, responseBytes, timeoutMs, durationMs, now = Date.now }) {
  for (const n of [maxCalls,maxBytes,responseBytes,timeoutMs,durationMs]) if (!Number.isSafeInteger(n)||n<1) throw new ReadStop('invalid_budget');
  const start = now(); let calls=0, bytes=0, stopped=false, busy=false;
  return {
    snapshot: () => ({calls,bytes,elapsedMs:now()-start,stopped,busy}),
    async read(transport, input) {
      if (stopped||busy||calls>=maxCalls||now()-start>=durationMs) { stopped=true; throw new ReadStop('budget_stopped'); }
      calls++; busy=true;
      const controller=new AbortController(); let timer;
      const remaining=Math.min(timeoutMs,durationMs-(now()-start));
      try {
        const raw=await Promise.race([
          Promise.resolve().then(() => {
            if (stopped || controller.signal.aborted) throw new ReadStop('dispatch_stopped');
            return transport(input, { signal: controller.signal, maxBytes: Math.min(responseBytes, maxBytes - bytes) });
          }),
          new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ReadStop('read_timeout_unsettled'));},remaining);}),
        ]);
        // Opaque connector results can only be bounded after receipt; no wire/memory guarantee.
        const value=raw instanceof ReadReply?raw.text:raw;
        const serialized=typeof value==='string'?value:JSON.stringify(value);
        let length=Buffer.byteLength(serialized);
        if (raw instanceof ReadReply) {
          if (!Number.isSafeInteger(raw.receivedBytes) || raw.receivedBytes < length) throw new ReadStop('invalid_byte_accounting');
          length = raw.receivedBytes;
        }
        bytes+=length;
        if(length>responseBytes||bytes>maxBytes) throw new ReadStop('response_bytes_exceeded');
        if(stopped||now()-start>=durationMs||controller.signal.aborted) throw new ReadStop('read_deadline');
        return typeof value==='string'?JSON.parse(value):value;
      } catch { stopped=true;controller.abort();throw new ReadStop('read_stopped'); }
      finally {clearTimeout(timer);busy=false;}
    },
    stop() {stopped=true;},
  };
}
/** Check a complete bounded CLI list. A saturated sentinel limit never passes. */
export function boundedList(value,maximum=1000) {
  if(!Array.isArray(value)||value.length>maximum) throw new ReadStop('list_saturated_or_invalid');
  return value;
}
