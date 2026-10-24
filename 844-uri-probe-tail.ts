});

describe("QA844 probe uri()", () => {
  const run = async (kind: "step" | "glb" | "usdz" | "iso" | "top", file: string | null | undefined) => {
    const runner: CadWorkerRunner = async (params) => {
      const outcome = fakeOutcome(params);
      if (file !== undefined) (outcome.result!.files as Record<string, unknown>)[kind] = file;
      return outcome;
    };
    const graph = graphWith(cadOnly(new CadAgent({ enabled: true, runner })));
    const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
    const terminal = await graph.waitForTerminal(runId);
    const events = graph.getEvents(runId);
    return { state: (terminal as { state: string }).state, artifacts: artifactsOf(events), last: events.at(-1) as Record<string, unknown> };
  };
  const bad = ["./plate.glb", "a/../plate.glb", "plate.glb/..", "../../../../etc/passwd", "/tmp/jd-fake/plate.glb", "sub/../../x", "./", "../", "/"];
  for (const kind of ["step", "glb", "usdz", "iso", "top"] as const) {
    it.each(bad)(`rejects ${kind}=%s`, async (file) => {
      const r = await run(kind, file);
      expect(r.state).toBe("failed");
      expect(String(r.last.message)).toContain("artifact file must stay inside the run folder");
      expect(r.artifacts).toEqual([]);
    });
  }
  it.each(["plate.glb", "plate v2.glb", "..plate.glb", "plate..glb", "my-plate_01.glb"])("accepts normal glb name %s", async (file) => {
    const r = await run("glb", file);
    expect(r.state).toBe("completed");
    expect(r.artifacts.find((a) => a.kind === "glb")?.uri.startsWith("file:///tmp/jd-fake/")).toBe(true);
  });
  it.each([undefined, null, ""])("usdz %s skipped", async (file) => {
    const r = await run("usdz", file as string | null | undefined);
    expect(r.state).toBe("completed");
    expect(r.artifacts.map((a) => a.kind)).toEqual(["step", "glb", "png", "png"]);
  });
  it("usdz plate.usdz published", async () => {
    const r = await run("usdz", "plate.usdz");
    expect(r.artifacts.find((a) => a.kind === "usdz")?.uri).toBe("file:///tmp/jd-fake/plate.usdz");
  });
});
