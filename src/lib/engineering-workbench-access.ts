/** Internal handoff tooling is admitted only by an explicit development flag on loopback. */
export function canOpenEngineeringWorkbench(development: boolean, flag: string | undefined, hostname: string): boolean {
  return development && flag === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
