# Supplied quoted-sample package

This directory contains the scrubbed `1093-05589-02` STEP/PDF package supplied
for local development and regression testing. The files are source fixtures,
not public web assets.

`scripts/seed-dev.mjs` uploads the package under generic names to the private
`job-files` bucket. Do not copy these files into `public/`, add their identity
to browser bundles, or weaken `scripts/verify-public-assets.mjs`; OVD-360's
unauthenticated-publication guard remains intentional.

