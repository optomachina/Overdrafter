import type { Run } from "../../../server/engineering/sample-plate-dispatch";

export type PlateSession = { csrf: string; runs: Run[] };
let apiPrefix = "/__sample_plate";
export function configurePrivatePlateClient() { apiPrefix = "/sample-plate/api"; }
export function plateApiPath(route: string) { return apiPrefix + route; }
let initialSession: Promise<PlateSession> | undefined;
async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(response.status === 401 ? "Open your private pairing or local launch link to connect this browser." : "Request not confirmed. Refresh status before trying again.");
  return response.json() as Promise<T>;
}
export function plateSession() { return fetch(plateApiPath("/session"), { cache: "no-store" }).then(json<PlateSession>); }
export function connectPlateSession() {
  if (new URLSearchParams(location.hash.slice(1)).has("launch")) initialSession = undefined;
  if (!initialSession) initialSession = (async () => {
    const capability = new URLSearchParams(location.hash.slice(1)).get("launch");
    if (capability) {
      history.replaceState(null, "", location.pathname);
      await fetch(plateApiPath("/bootstrap"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability }) }).then(json);
    }
    return plateSession();
  })();
  return initialSession;
}
export function requestPlate(csrf: string, id: string, instruction: string) {
  return fetch(plateApiPath("/runs"), { method: "POST", headers: { "Content-Type": "application/json", "X-Plate-CSRF": csrf }, body: JSON.stringify({ id, instruction }) }).then(json<Run>);
}
