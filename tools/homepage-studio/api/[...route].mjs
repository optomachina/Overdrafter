// Thin Vercel function: all logic lives in lib/api.mjs.
import { fetchHandler } from "../lib/vercel-handler.mjs";

export default { fetch: fetchHandler };
export const GET = fetchHandler;
export const POST = fetchHandler;
