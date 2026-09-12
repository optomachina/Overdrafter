import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import { useAppSession } from "@/hooks/use-app-session";
import { ConversationMessage, EngineeringConversationLayout } from "@/features/engineering/EngineeringConversationLayout";
import { EngineeringTaskStatus } from "@/features/engineering/EngineeringTaskStatus";
import { prepareEngineeringMessage, submitEngineeringMessage, type EngineeringMessage, type EngineeringMessageOutcome } from "@/features/engineering/engineering-inbox-client";
import { readEngineeringConversation, type EngineeringConversationContext as Conversation, type EngineeringHistoryMessage as Message } from "@/features/engineering/engineering-conversation-reader";

const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const outcomeText = {
  recorded: "Request recorded. CAD execution has not been confirmed.",
  conflict: "The conversation changed. Review its latest context before sending again.",
  access_unavailable: "Access or context is unavailable. Your original request is retained here.",
  invalid_request: "This request could not be accepted. Check its text and context.",
  delivery_unknown: "Delivery is uncertain. Retry the original request to check whether it was recorded.",
};
const secondaryActionClass = "rounded-full border border-border px-3 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

/** Authenticated intake for an existing conversation; server RLS remains the access authority. */
export default function EngineeringInbox() {
  const session = useAppSession();
  const [search] = useSearchParams();
  const id = search.get("conversation") ?? "";
  if (session.isAuthInitializing) return <p role="status">Checking your session…</p>;
  if (!session.user || session.authState !== "authenticated") return <p>Sign in to open your engineering conversation. <a href="/signin">Sign in</a></p>;
  if (!identity.test(id)) return <p>Open an existing engineering conversation link to continue.</p>;
  // Account/context changes unmount all private display and pending request state.
  return <InboxConversation key={`${session.user.id}:${id}`} id={id} owner={session.user.id} />;
}

function InboxConversation({ id, owner }: { readonly id: string; readonly owner: string }) {
  const [context, setContext] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<EngineeringMessage | null>(null);
  const [outcome, setOutcome] = useState<EngineeringMessageOutcome["status"] | null>(null);
  const [review, setReview] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Opening conversation…");
  const [open, setOpen] = useState(true);
  const live = useRef(true);
  const locked = useRef(false);

  async function readConversation() {
    const result = await readEngineeringConversation(id, owner);
    if (live.current) setMessages(result.messages);
    return result.context;
  }

  async function refresh(forReview = false) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const current = await readConversation();
      if (!live.current) return;
      if (forReview) {
        setReview(current);
        setNotice("Review the updated conversation and context below. Nothing has been resent.");
      } else {
        setContext(current);
        setNotice("Conversation loaded. Showing up to 100 recent messages.");
      }
    } catch {
      if (live.current) setNotice("Conversation unavailable. Check your access and try again.");
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }

  useEffect(() => {
    live.current = true;
    void refresh();
    return () => { live.current = false; };
    // This component is keyed by owner and conversation; reads are explicit after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (locked.current || !context || outcome === "conflict") return;
    let submission = pending;
    if (!submission) {
      try {
        submission = prepareEngineeringMessage({ organizationId: context.organization_id,
          projectId: context.project_id, conversationId: context.id, inputSnapshotId: context.head_snapshot_id,
          expectedRevision: context.revision, idempotencyKey: crypto.randomUUID(), body: draft });
      } catch {
        setNotice("Enter a message within 4,000 characters and 8,000 bytes.");
        return;
      }
    }
    locked.current = true;
    setBusy(true);
    setPending(submission);
    setOpen(true);
    setNotice("Recording request…");
    const result = await submitEngineeringMessage(submission);
    if (!live.current) return;
    setOutcome(result.status);
    setNotice(outcomeText[result.status]);
    if (result.status === "invalid_request") setPending(null);
    if (result.status === "recorded") {
      setPending(null);
      setDraft("");
      setContext(null); // A replay receipt must never become the current head/revision.
      try {
        const current = await readConversation();
        if (live.current) setContext(current);
      } catch {
        if (live.current) setNotice(`${outcomeText.recorded} Refresh to load the latest conversation.`);
      }
    }
    locked.current = false;
    if (live.current) setBusy(false);
  }

  return <EngineeringConversationLayout title="Private engineering conversation" conversationOpen={open} onConversationToggle={() => setOpen(!open)}
    cadPanel={<p className="p-8 text-center text-sm text-muted-foreground">CAD results are not connected to this conversation view yet.</p>}
    contextSummary={<p>Existing private conversation. Requests are recorded separately from CAD execution and verification.</p>}
    toolsPanel={<button type="button" disabled={busy || !!pending} onClick={() => void refresh()} className={secondaryActionClass}>Refresh conversation</button>}
    conversation={<>
      {messages.map((message) => <ConversationMessage key={message.id} role={message.role === "user" ? "user" : "assistant"}><p className="whitespace-pre-wrap">{message.body}</p></ConversationMessage>)}
      {context && <EngineeringTaskStatus conversationId={context.id} organizationId={context.organization_id} projectId={context.project_id} ownerId={owner} />}
      <p role="status">{notice}</p>
      {pending && <div><p className="text-xs">Original pending request — keep this tab open until delivery is resolved.</p><p className="whitespace-pre-wrap">{pending.body}</p></div>}
      {outcome === "conflict" && <button type="button" disabled={busy} onClick={() => void refresh(true)} className={secondaryActionClass}>Review latest context</button>}
      {review && <div className="space-y-2 text-sm"><p>Revision {pending?.expectedRevision} → {review.revision}</p>
        <p className="break-all">Snapshot {pending?.inputSnapshotId} → {review.head_snapshot_id}</p>
        <p>Your next Send will be a new request against this context.</p>
        <button type="button" disabled={busy} onClick={() => { setContext(review); setReview(null); setPending(null); setOutcome(null); setNotice("Updated context selected. Review your text, then Send."); }} className={secondaryActionClass}>Use updated context</button>
      </div>}
    </>}
    composer={<form onSubmit={send} className="flex items-end gap-2">
      <textarea aria-label="Message" placeholder="Message OverDrafter" value={draft} disabled={busy || !!pending}
        rows={1} onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; }}
        className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-white placeholder:text-neutral-400 focus:outline-none" />
      <button type="submit" aria-label={pending ? "Retry original request" : "Send message"} disabled={busy || !context || outcome === "conflict" || (!pending && !draft.trim())}
        className="flex min-h-10 min-w-10 items-center justify-center rounded-full bg-white px-3 text-black disabled:opacity-40">
        {pending ? "Retry" : <ArrowUp aria-hidden="true" className="size-4" />}
      </button>
    </form>} />;
}
