# Public demo assets

Every file in this directory is copied into the production build and is
downloadable without authentication.

The placeholder drawing and SVG pages are maintained as public-use synthetic
UI assets. They carry no customer-derived part identity or manufacturing scope.
The quoted-sample CAD/PDF package lives under `test-fixtures/` and local seeds
upload it to private storage; no CAD fixture is served from this directory.

Never place a private validation package, customer file, or extraction corpus
drawing here. `npm run build` scans both this directory and the generated
`dist/` tree for prohibited filenames, hashes, identity markers, and any
unapproved CAD/PDF fixture binary.
