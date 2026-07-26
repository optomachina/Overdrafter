# Corpus drawings

Scrubbed drawings live here. Run every file through
`scripts/scrub_drawing.py` before adding it — see `../README.md`.

The one existing case points at `public/fixtures/1093-05589-02.pdf` instead of
a copy here, because the app's dev seed (`scripts/seed-dev.mjs`, via
`QUOTED_SAMPLE_ASSETS`) uploads that same file as demo data. Keeping one copy
means the drawing the seed serves and the drawing the gate scores cannot drift
apart. That file is safe to serve publicly *because* it is scrubbed; an
unscrubbed drawing must never be placed in `public/`.
