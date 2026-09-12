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
afterEach(() => vi.useRealTimers());

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

  it.each([
    { ...context, owner_user_id: snapshot },
    { ...context, id: snapshot },
    { ...context, organization_id: "bad" },
    { ...context, revision: -1 },
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
    [{ ...message, id: "bad" }],
    [{ ...message, sequence: 1.5 }],
    [message, message],
    Array.from({ length: 101 }, () => message),
  ])("rejects malformed history without exposing its content: %j", async (data) => {
    query.response.mockReset().mockResolvedValueOnce({ data: context, error: null }).mockResolvedValueOnce({ data, error: null });
    await expect(readEngineeringConversation(id, owner)).rejects.toThrow("Conversation unavailable.");
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
