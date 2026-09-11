# Prepared result test fixtures

These are OverDrafter-generated synthetic two-cylinder fixtures, not customer
CAD. The native files total 174,523 bytes and are retained output from attempt
`e99b4f84-f2ee-4d76-8de7-b5ae2768770a` at source
`b6434ea9f48000505e55abae5bd275aee012c3c3` (5→8 mm).

OVD-505 attachment `7aff9a6b-844b-4635-9849-6d0761b5238c`, packet SHA256
`75fd6cf399fc38a93e67be6cc293a2fb538da0b9af89d1fb99fdd6df4ed2aff8`,
supplied the three exact byte streams with matching pre/post observations.
Their identities independently match the earlier verified native result.
The original native qualification remains OVD-503 attachment
`ee81d9e3-f1b0-4094-949c-4194fcfc83ac`; transferring these bytes did not rerun CAD.

`prepared-reports.json` contains sanitized report observations from that run.
Test paths and process identities differ from the retained original evidence.
Tests recompute their own job/context/report bindings. These modified reports
are not qualification receipts and confer no worker or process-stop authority.

The native files preserve their exact original bytes, including native reference
history. Tests read/hash them; they do not open or execute CAD, macros or native
libraries. Reading these fixtures proves stored-byte verification, not native
behavior on a different machine. `.gitattributes` prevents newline conversion.
