# Private sample access (OVD-579)

This service shares the existing verified sample and its exact files with the
owner's paired Tailscale devices. It never imports a native adapter, calls Jev,
or starts another CAD build. The original local demo and permanent attempt lock
remain unchanged. Phone access is not phone-to-new-CAD qualification.

## Build and launch

Run `npm ci`, then `npm run build:sample-plate`. This builds a dedicated static
entry in `dist-sample-plate`; it is separate from the production app build and
contains no Vite development/filesystem server. The CI build checks both entries.

On the existing Windows workstation, inspect `tailscale status --json` and
`tailscale serve status --json`. Retain the expected existing DNS name and user
ID; do not create accounts, expand policy grants, enable Funnel or change the
firewall. Start with the retained sample output directory:

```powershell
./scripts/start-private-sample-plate.ps1 -OutputRoot '<existing sample output root>' -ExpectedDns '<verified workstation.ts.net>' -ExpectedUserId '<verified existing user ID>'
```

The launcher rechecks the online identity and HTTPS certificate domain, protects
the dedicated AppData pairing directory, and starts only a loopback listener on
8092. Startup requires the permanent native lock, a succeeded journal result,
all nine checks, and both hash-matching files. It writes no native journal data.

After targeted tests and independent review, add only the owned private route
if that path/HTTPS port has no conflicting owner:

```text
tailscale serve --bg --https=443 --set-path=/sample-plate http://127.0.0.1:8092
```

Reinspect Serve configuration: only the intended private handler may change and
there must be no public Funnel mapping. Preserve unrelated entries. The public
URL is `https://<verified workstation.ts.net>/sample-plate/`.

## Pairing and trust

Two separate one-use links are saved under
`%LOCALAPPDATA%/OverDrafter/sample-plate-phone/<unique launch directory>`: `ovd579-phone-pairing.json` and
`ovd579-mac-verification-pairing.json`. Each JSON contains `url` and `expiresAt`.
Each launch uses a newly created directory with inherited ACLs removed and only owner/SYSTEM access; files are created exclusively and never overwrite old capability files. They expire ten minutes after service startup, and are usable only by the exact
verified Tailscale login. Keep the phone link separate from verification.
Transfer a link only through a private existing same-user channel such as
Taildrop; do not print links, capabilities, cookies or keys into logs/chat.
Open the link in the target device's browser. The fragment is exchanged for a
Secure, HttpOnly, SameSite=Strict cookie and removed from the address bar.
Sessions last one hour. A service restart revokes all sessions and old links;
it preserves the native lock and results. Re-pair explicitly after expiry.

Serve authenticates the tailnet client and strips/replaces identity headers.
Only this dedicated loopback ingress trusts `Tailscale-User-Login`, and only for
the verified owner. Tagged clients or other logins are rejected. Local processes
on the workstation remain part of the OS trust boundary; identity headers alone
do not protect against hostile local processes. The additional random pairing
capability is kept in an owner/SYSTEM-only directory. Tailnet membership alone
is never sufficient. See [Tailscale Serve identity documentation](https://tailscale.com/docs/features/tailscale-serve).

The handler pins exact external Host/Origin, rejects arbitrary forwarded hosts,
requires JSON and exact Origin for bootstrap, consumes each link once, and binds
each session to the same identity. All native-write routes deny access even with
a valid CSRF token. Static content comes from an in-memory fixed asset allowlist;
downloads recheck canonical containment, size and SHA256 on every request.

## Acceptance and operation

Run the private ingress tests plus the existing local demo tests, typecheck,
lint, both builds and hosted integration gates. Confirm a real remote tailnet
browser pairs successfully, sees all nine retained checks, and downloads exact
SLDPRT/STEP bytes. Verify wrong identity/Host/Origin, absent session, replay,
expiry, missing/changed artifacts, development paths and new-build requests fail.
An offline phone is a pending real-device check, never a claimed phone pass;
use an existing online paired Mac to verify the deployed route independently.

To stop this service, remove only the owned `/sample-plate` Serve handler and
stop the verified 8092 process. Do not reset all Serve configuration, stop the
8091 local demo, touch SolidWorks, delete the attempt lock or change the output
root. Keep artifact/source hashes and the original native receipt for audit.
