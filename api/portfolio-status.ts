import { timingSafeEqual } from "node:crypto";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const PROJECT_NAME = "OverDrafter 1.0 Controlled Beta — Part to Quote";
const KEY_ISSUE_IDS = [
  "OVD-410",
  "OVD-417",
  "OVD-416",
  "OVD-206",
  "OVD-199",
  "OVD-408",
  "OVD-319",
  "OVD-358",
] as const;

const PORTFOLIO_QUERY = `
  query Portfolio($name: String!) {
    projects(filter: { name: { eq: $name } }, first: 1) {
      nodes {
        name
        progress
        updatedAt
        startDate
        targetDate
        state
        projectMilestones {
          nodes { name description progress targetDate }
        }
        issues(first: 250) {
          nodes {
            identifier
            title
            priority
            updatedAt
            url
            state { name type }
            parent { identifier }
          }
        }
      }
    }
  }
`;

type FetchLike = typeof fetch;

type RuntimeConfig = {
  linearApiKey: string;
  dashboardToken: string;
};

type LinearIssue = {
  identifier: string;
  title: string;
  priority: number;
  updatedAt: string;
  url: string;
  state: { name: string; type: string };
  parent: { identifier: string } | null;
};

type LinearProject = {
  name: string;
  progress: number;
  updatedAt: string;
  startDate: string | null;
  targetDate: string | null;
  state: string;
  projectMilestones: {
    nodes: Array<{
      name: string;
      description: string | null;
      progress: number;
      targetDate: string | null;
    }>;
  };
  issues: { nodes: LinearIssue[] };
};

function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig | null {
  const linearApiKey = env.LINEAR_API_KEY?.trim();
  const dashboardToken = env.PORTFOLIO_DASHBOARD_TOKEN?.trim();
  if (!linearApiKey || !dashboardToken) return null;
  return { linearApiKey, dashboardToken };
}

function tokenMatches(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function responseHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function isLinearProject(value: unknown): value is LinearProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<LinearProject>;
  return (
    project.name === PROJECT_NAME &&
    typeof project.progress === "number" &&
    typeof project.updatedAt === "string" &&
    typeof project.state === "string" &&
    Array.isArray(project.projectMilestones?.nodes) &&
    Array.isArray(project.issues?.nodes)
  );
}

function summarize(project: LinearProject) {
  const counts: Record<string, number> = {};
  for (const issue of project.issues.nodes) {
    counts[issue.state.name] = (counts[issue.state.name] ?? 0) + 1;
  }

  const byId = new Map(project.issues.nodes.map((issue) => [issue.identifier, issue]));
  const keyIssues = KEY_ISSUE_IDS.flatMap((identifier) => {
    const issue = byId.get(identifier);
    if (!issue) return [];
    return [{
      id: issue.identifier,
      title: issue.title,
      status: issue.state.name,
      priority: issue.priority,
      parentId: issue.parent?.identifier ?? null,
      updatedAt: issue.updatedAt,
      url: issue.url,
    }];
  });

  return {
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: project.updatedAt,
    project: {
      name: project.name,
      status: project.state,
      progress: project.progress,
      startDate: project.startDate,
      targetDate: project.targetDate,
    },
    issueCount: project.issues.nodes.length,
    counts,
    milestones: project.projectMilestones.nodes.map((milestone) => ({
      name: milestone.name,
      description: milestone.description,
      progress: milestone.progress,
      targetDate: milestone.targetDate,
    })),
    keyIssues,
  };
}

/** Build the private read-only Linear portfolio endpoint. */
export function createPortfolioStatusHandler(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    const config = loadConfig(env);
    if (!config) return json({ error: "portfolio_unavailable" }, 503);

    const authorization = request.headers.get("authorization") ?? "";
    const suppliedToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!tokenMatches(suppliedToken, config.dashboardToken)) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      const response = await fetchImpl(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: config.linearApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: PORTFOLIO_QUERY, variables: { name: PROJECT_NAME } }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object") {
        return json({ error: "linear_unavailable" }, 502);
      }

      const result = payload as {
        errors?: unknown;
        data?: { projects?: { nodes?: unknown[] } };
      };
      if (result.errors || result.data?.projects?.nodes?.length !== 1) {
        return json({ error: "linear_unavailable" }, 502);
      }
      const project = result.data.projects.nodes[0];
      if (!isLinearProject(project)) return json({ error: "linear_contract_invalid" }, 502);
      return json(summarize(project));
    } catch {
      return json({ error: "linear_unavailable" }, 502);
    }
  };
}

const handler = createPortfolioStatusHandler();

export default { fetch: handler };
