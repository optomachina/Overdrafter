import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEngineeringConversation } from "./engineering-conversation-reader";

const query = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(), response: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: query.from } }));
const id = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const snapshot = "10000000-0000-4000-8000-000000000003";
const context = { id, owner_user_id: owner, organization_id: id, project_id: id, head_snapshot_id: snapshot, revision: 3 };
const message = { id: snapshot, conversation_id: id, owner_user_id: owner, organization_id: id, project_id: id, role: "assistant", body: "  Which depth?\n", sequence: 2 };
beforeEach(() => {
  vi.resetAllMocks();
  for (const name of ["from", "select", "eq", "single", "order", "limit"] as const) query[name].mockReturnValue(query);
  query.response.mockResolvedValueOnce({ data: context, error: null }).mockResolvedValueOnce({ data: [message], error: null });
  query.abortSignal.mockImplementation(() => {
    const pending = Promise.resolve(query.response());
    return Object.assign(pending, { single: () => pending });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bounded private conversation read", () => {
  it("returns immutable scoped context and chronological history without rewriting text", async () => {
    const result = await readEngineeringConversation(id, owner);
    expect(result.context).toEqual(context);
    expect(result.messages).toEqual([{ id: snapshot, role: "assistant", body: message.body, sequence: 2 }]);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    for (const [key, value] of [["conversation_id", id], ["organization_id", id], ["project_id", id], ["owner_user_id", owner]]) expect(query.eq).toHaveBeenCalledWith(key, value);
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(query.abortSignal.mock.calls[0][0]).toBe(query.abortSignal.mock.calls[1][0]);
  });

  it("reads committed history at the final revision even though another Send is unavailable", async () => {
    const terminalContext = { ...context, revision: Number.MAX_SAFE_INTEGER };
    const terminalMessage = { ...message, sequence: Number.MAX_SAFE_INTEGER };
    query.response.mockReset().mockResolvedValueOnce({ data: terminalContext, error: null })
      .mockResolvedValueOnce({ data: [terminalMessage], error: null });
    const result = await readEngineeringConversation(id, owner);
    expect(result.context).toEqual(terminalContext);
    expect(result.messages).toEqual([{ id: snapshot, role: message.role, body: message.body, sequence: Number.MAX_SAFE_INTEGER }]);
  });

  it.each([
    { ...context, owner_user_id: snapshot },
    { ...context, id: snapshot },
    { ...context, organization_id: "bad" },
    { ...context, project_id: "bad" },
    { ...context, head_snapshot_id: "00000000-0000-0000-0000-000000000000" },
    { ...context, revision: -1 },
    { ...context, revision: 1.5 },
    { ...context, revision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects mismatched or invalid context before reading history: %j", async (data) => {
    query.response.mockReset().mockResolvedValue({ data, error: null });
    await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
    expect(query.from).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [{ ...message, conversation_id: snapshot }],
    [{ ...message, organization_id: snapshot }],
    [{ ...message, project_id: snapshot }],
    [{ ...message, owner_user_id: snapshot }],
    [{ ...message, role: "admin" }],
    [{ ...message, body: "" }],
    [{ ...message, body: "x".repeat(4001) }],
    [{ ...message, body: "\ud800" }],
    [{ ...message, id: "bad" }],
    [{ ...message, sequence: 1.5 }],
    [message, message],
    Array.from({ length: 101 }, () => message),
  ])("rejects malformed history without exposing its content: %j", async (data) => {
    query.response.mockReset().mockResolvedValueOnce({ data: context, error: null }).mockResolvedValueOnce({ data, error: null });
    await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
  });

  it.each(["head", "history", "context validation", "history validation"].flatMap((phase) =>
    [9_999, 10_000, 10_001].map((elapsed) => ({ phase, elapsed }))))(
    "enforces elapsed $elapsed ms during $phase while the timer callback is pending", async ({ phase, elapsed }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let clock = 100;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      const advance = () => { clock = 100 + elapsed; };
      const head = { ...context, get revision() {
        if (phase === "context validation") advance();
        return context.revision;
      } };
      const row = { ...message, get body() {
        if (phase === "history validation") advance();
        return message.body;
      } };
      query.response.mockReset().mockImplementationOnce(() => {
        if (phase === "head") advance();
        else clock += 6_000;
        return { data: head, error: null };
      }).mockImplementationOnce(() => {
        if (phase === "history") advance();
        return { data: [row], error: null };
      });
      const pending = readEngineeringConversation(id, owner);
      if (elapsed < 10_000) {
        const result = await pending;
        expect(result.context).toEqual(context);
        expect(result.messages[0].body).toBe(message.body);
      } else {
        await expect(pending).rejects.toThrow("Conversation unavailable.");
      }
      expect(query.from).toHaveBeenCalledTimes(elapsed >= 10_000 && ["head", "context validation"].includes(phase) ? 1 : 2);
      const signal = query.abortSignal.mock.calls[0][0];
      expect(signal.aborted).toBe(elapsed >= 10_000);
      for (const [readSignal] of query.abortSignal.mock.calls) expect(readSignal).toBe(signal);
      expect(vi.getTimerCount()).toBe(0);
    });

  it("refuses the first query if the elapsed budget is already exhausted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(10_100);
    await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
    expect(query.from).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["head", "history"].flatMap((phase) =>
    [9_999, 10_000, 10_001].map((elapsed) => ({ phase, elapsed }))))(
    "aborts shared reads on $phase rejection at elapsed $elapsed ms", async ({ phase, elapsed }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let clock = 100;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      const rejectLate = () => {
        clock = 100 + elapsed;
        return Promise.reject(new Error("private transport detail"));
      };
      query.response.mockReset();
      if (phase === "history") query.response.mockResolvedValueOnce({ data: context, error: null });
      query.response.mockImplementationOnce(rejectLate);
      await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
      expect(query.from).toHaveBeenCalledTimes(phase === "head" ? 1 : 2);
      expect(query.abortSignal.mock.calls[0][0].aborted).toBe(elapsed >= 10_000);
      expect(vi.getTimerCount()).toBe(0);
    });

  it("does not launch history reads when a timed-out head response arrives late", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void;
    query.response.mockReset().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = readEngineeringConversation(id, owner);
    const rejected = expect(pending).rejects.toThrow("Conversation unavailable.");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true);
    finish({ data: context, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(query.from).toHaveBeenCalledTimes(1);
  });

  it("uses one ten-second deadline across head and history reads", async () => {
    vi.useFakeTimers();
    query.response.mockReset().mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ data: context, error: null }), 6000)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ data: [message], error: null }), 6000)));
    const pending = readEngineeringConversation(id, owner);
    const rejected = expect(pending).rejects.toThrow("Conversation unavailable.");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(query.from).toHaveBeenCalledTimes(2);
    expect(query.abortSignal.mock.calls[1][0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(query.from).toHaveBeenCalledTimes(2);
  });

  it("clears its timer on a server failure without leaking diagnostics", async () => {
    vi.useFakeTimers();
    query.response.mockReset().mockResolvedValue({ data: null, error: { message: "sensitive", code: "42501" } });
    await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
    expect(vi.getTimerCount()).toBe(0);
  });
});
