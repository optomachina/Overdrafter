import { createAdminOperationsHandler } from "../server/admin-operations/handler";
import { createAdminOperationsRuntime } from "../server/admin-operations/runtime";

/** Read-only platform-admin boundary; provider policy is absent until independently supplied. */
export default { fetch: (request: Request) => createAdminOperationsHandler(createAdminOperationsRuntime(process.env))(request) };
