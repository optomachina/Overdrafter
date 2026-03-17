export function resolveDiagnosticsRouteMode(search: string) {
  const params = new URLSearchParams(search);

  return {
    debugValue: params.get("debug"),
    embedded: params.get("embed") === "1",
  };
}
