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
