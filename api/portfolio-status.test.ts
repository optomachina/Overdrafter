// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createPortfolioStatusHandler } from "./portfolio-status";

const ENV = {
  LINEAR_API_KEY: "linear-private-key",
  PORTFOLIO_DASHBOARD_TOKEN: "dashboard-private-token",
};

function request(token = ENV.PORTFOLIO_DASHBOARD_TOKEN) {
  return new Request("https://app.example.com/api/portfolio-status", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function linearResponse() {
  return new Response(JSON.stringify({
    data: {
      projects: {
        nodes: [{
          name: "OverDrafter 1.0 Controlled Beta — Part to Quote",
          progress: 0.5,
          updatedAt: "2026-08-24T00:00:00.000Z",
          startDate: "2026-08-13",
          targetDate: null,
          state: "started",
          projectMilestones: {
            nodes: [{ name: "Scope Locked", description: "Rules agree.", progress: 100, targetDate: null }],
          },
          issues: {
            nodes: [
              {
                identifier: "OVD-410",
                title: "Stable hosted authentication",
                priority: 2,
                updatedAt: "2026-08-24T00:00:00.000Z",
                url: "https://linear.app/overdrafter/issue/OVD-410/example",
                state: { name: "In Progress", type: "started" },
                parent: { identifier: "OVD-206" },
              },
              {
                identifier: "OVD-206",
                title: "Hosted Xometry certification",
                priority: 2,
                updatedAt: "2026-08-24T00:00:00.000Z",
                url: "https://linear.app/overdrafter/issue/OVD-206/example",
                state: { name: "Blocked", type: "started" },
                parent: null,
              },
            ],
          },
        }],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("private Linear portfolio function", () => {
  it("rejects missing or incorrect access tokens before contacting Linear", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const handler = createPortfolioStatusHandler(ENV, fetchMock);

    expect((await handler(new Request("https://app.example.com/api/portfolio-status"))).status).toBe(401);
    expect((await handler(request("wrong-token"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a bounded project summary without exposing configuration", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(linearResponse());
    const response = await createPortfolioStatusHandler(ENV, fetchMock)(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      issueCount: 2,
      counts: { "In Progress": 1, Blocked: 1 },
      project: { status: "started", progress: 0.5 },
      keyIssues: [
        { id: "OVD-410", status: "In Progress" },
        { id: "OVD-206", status: "Blocked" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(ENV.LINEAR_API_KEY);
    expect(JSON.stringify(body)).not.toContain(ENV.PORTFOLIO_DASHBOARD_TOKEN);
  });

  it("fails closed with a sanitized response when Linear is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("private upstream details"));
    const response = await createPortfolioStatusHandler(ENV, fetchMock)(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "linear_unavailable" });
  });

  it("fails closed when server configuration is absent", async () => {
    const response = await createPortfolioStatusHandler({}, vi.fn<typeof fetch>())(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "portfolio_unavailable" });
  });
});
