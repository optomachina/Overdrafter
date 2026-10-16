# Jarvis demo (OVD-765)

A rehearsal of "tell the Workstation to design an assembly from the phone" for
nights when the Windows SolidWorks Workstation is offline. Demo only: it is off
unless `JARVIS_DEMO_ENABLED=1`, uses local files, and calls no hosted service,
no SolidWorks and no provider. It is not OVD-520 native evidence.

- `jarvis-demo.mjs request "<text>"` files a request in `$JARVIS_DEMO_ROOT/queue/pending`.
  The parser accepts only a bracket + plate + pin assembly with a 4 to 20 mm pin.
- `jarvis-demo.mjs work` claims the oldest request with an atomic rename and runs
  `assembly.py`. The run writes `runs/<id>/` with one STEP per part, `assembly.step`,
  `assembly.png`, `result.json` (checks) and `outcome.json`.
- `assembly.py` uses build123d (OpenCascade). It checks one valid solid per part,
  no pairwise interference, the pin clearance, that the pin passes through the
  upright, and that the bracket is seated. A failed check exits 2 and is never retried.

## Plate recipe (OVD-802)

The design graph's `CadAgent` (`server/design-graph/cad-agent.ts`) uses this worker through the same queue:

- `jarvis-demo.mjs plate '<params json>'` validates the params and files the plate job directly into `queue/claimed/`, so no concurrent `work` can take it, then runs `plate.py`. Plate jobs need `JARVIS_CAD_AGENT_ENABLED=1` as well as `JARVIS_DEMO_ENABLED=1`. With the CAD flag off, `plate` files nothing, and `work` puts a claimed plate job back in `pending/`. The params are `recipe: "plate"`, `edgeMm: 101.6`, `thicknessMm` (0.5 to 50), `holePattern` (`none`, `four_corner_m5` or `four_corner_1_4_20`) and `material`. Any other value is refused, and nothing is filed. `work` runs a queued plate job like any other job.
- `plate.py` writes `plate.step` (authoritative), `plate.glb` (binary glTF in metres, a derived review view), `plate-iso.png`, `plate-top.png` and `result.json`. It checks for one valid solid, re-imports the STEP and measures its bounding box against the expected size (within 0.01 mm), and confirms the GLB is watertight. A failed check exits 2.
- `glb_check.py` parses a GLB with only `struct` and numpy. It merges coincident vertices and requires every edge to be shared by exactly two triangles. Run it standalone with `python glb_check.py <file.glb>`; it reads only `.glb` files under `$JARVIS_DEMO_ROOT/runs`.
- Each Python run has a time limit, `JARVIS_DEMO_WORKER_TIMEOUT_MS` (default 300000). Python runs in its own process group. On a timeout, or when the CLI gets SIGTERM or SIGINT, the CLI kills that whole group, moves the claim to `failed/` and writes `outcome.json`. A job with an unknown recipe also fails with `reason: "unknown recipe"`.
- The worker runs Python with `PYTHONDONTWRITEBYTECODE=1`, so `plate.py` importing `glb_check` leaves no `__pycache__` in the repo.

Python setup (outside the repo's dependency files):

```bash
uv venv --python 3.12 ~/overnight/jarvis/.venv
uv pip install --python ~/overnight/jarvis/.venv/bin/python build123d matplotlib
```

Phone trigger: the Hermes gateway on the Mac mini, with a local skill that runs
`jarvis-design` (`request`, then `work`) and replies with the render.

Install on the Mac mini:

```bash
mkdir -p ~/overnight/jarvis/bin
ln -sf "$PWD/scripts/jarvis-demo/jarvis-design.sh" ~/overnight/jarvis/bin/jarvis-design
cp -R scripts/jarvis-demo/hermes/jarvis-workstation-design <hermes-skills-dir>/
```

The wrapper resolves this directory through the symlink (override with
`JARVIS_DEMO_REPO`), prints the outcome plus the `result.json` and `assembly.png`
paths, and exits nonzero if the request is refused or the run is not verified.
