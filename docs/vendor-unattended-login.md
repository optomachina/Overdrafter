# Unattended vendor login (OVD-1060)

`login:vendors` signs in to vendor quote portals with credentials from Bitwarden, so Blaine is no longer the manual login step for each session under `worker/state/`. It covers Quickparts, Geomiq and Weerg. OSH Cut stays refused until OVD-1022.

## Who runs what

| Command | Who runs it | What it does |
| -- | -- | -- |
| `npm --prefix worker run login:vendors` | Blaine's terminal or his LaunchAgent only | Kill switch, session check, then at most one password login per vendor that needs it |
| `npm --prefix worker run session:check` | Anyone, agents included | Prints `valid`, `login_required`, `missing`, `unopenable_by_kernel` or `check_failed` per vendor |
| `npm --prefix worker run session:refresh` | Anyone, agents included | Revisits a still-valid session and re-saves it |

`session:check` and `session:refresh` send only GET and HEAD requests to the vendor. They never read credentials, fill a form, click or upload. `session:refresh` also reads the provider kill switch from OverDrafter's own Supabase when service-role credentials are set.

Agents never run `login:vendors`, never start or kickstart its LaunchAgent, never read the login config's Bitwarden items, never read the keychain, and never type a password or solve a CAPTCHA. Running it would retrieve real credentials, which `AGENTS.md` lists as a protected action.

The tool also refuses to start in two cases:

- an agent runtime's environment markers are present;
- it has neither an interactive terminal nor its LaunchAgent environment.

That check is only a tripwire against an accidental run. It is not a security boundary: a process that allocates a terminal without those markers, or runs `launchctl kickstart`, gets past it.

Before a live run, an agent runs `session:check` for the vendors in that run. If any vendor is not `valid`, the agent sends Blaine one request that lists every vendor needing a login, instead of one request per vendor.

`check_failed` means the check could not decide, and logging in again may not fix it. Its reason says why:

- `challenge_page`, `http_forbidden`, `navigation_failed`: a challenge, a denial, or a network failure;
- `unconfirmable_public_landing` or `anonymous_comparison_inconclusive`: the landing page looks the same with and without the session, or the comparison visit without it did not come back clearly signed out;
- `settled_page_indeterminate`: the landing page showed an error, a spinner or a second-factor prompt rather than a signed-in or signed-out page, even if it also showed a log out control;
- `worker_reads_session_from_env`: `QUOTE_VENDOR_STORAGE_STATE_JSON` or `QUOTE_VENDOR_STORAGE_STATE_PATHS` names the vendor, so the worker would not read the file in the state directory.

## What `login:vendors` does per vendor

1. **Kill switch.** When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set (the main checkout's `worker/.env`), it reads the provider kill switch. If the switch is engaged or cannot be read, the vendor is skipped. Without those credentials the switch is reported as `not_checked`.
2. **Session check.** It runs the same check as `session:check`, and the result decides the next step:
   - **valid:** it re-saves the refreshed session and stops there, with no password and no vault unlock.
   - **missing, unopenable or signed out:** it moves on to a password login.
   - **check_failed:** it stops the vendor.

   `--force` skips this step.
3. **Credentials.** It unlocks Bitwarden at most once per run and reads the vendor's login item. The item must hold a URI on the vendor's reviewed hosts; otherwise the tool refuses it, so a password saved for another site is never typed into a vendor page.
4. **Login.** It opens the workflow's `loginUrl` in Chromium and fills the form with generic heuristics. It handles a visible form, a sign-in button that opens a modal, and an email-first then password step.
   - **Typing.** It types the password only into a visible sign-in field in the main frame, while the page is on a reviewed host. It refuses, before typing:
     - a form that submits to another host or into another frame or window;
     - a field marked as a new password;
     - a form whose button reads as sign-up, register, reset or subscribe;
     - a form whose text says create account, confirm password or reset password;
     - a generic Continue or Submit button with no sign-in context around it.

     It checks for every stop condition before typing, and again before its single submit.
   - **Request guard.** A reviewed origin is exactly `https://` on the default port to one of the vendor's session hosts or definition hosts. A subdomain, another port and the off-host subresource allowlist are not reviewed origins. It aborts:
     - a script navigation of the main frame to another host;
     - any popup;
     - a POST-style request from any frame or worker, or a POST-style navigation of any frame, to an origin that is not reviewed;
     - a WebSocket from any frame to anything but a reviewed `wss://` origin, before and after typing;
     - once the password is typed, any child-frame navigation to such an origin, and any request whose URL carries the password.
   - **Limit.** Playwright cannot hold a server redirect. If a reviewed host redirects the submitted form to another host (HTTP 307 or 308), the tool detects it afterwards, stops, and saves nothing. The password has already left by then. The tool trusts each vendor's reviewed hosts with that vendor's own password.
5. **Confirmation.** It opens the vendor's landing page, the page the kernel opens first, and needs positive evidence of a signed-in session:
   - either a log out control;
   - or real page content with no password field and no sign-in, loading, error or second-factor text.

   The vendor definition's own terminal-signal classifier must accept the page as well. The tool then scopes the session to the reviewed hosts (`scopeStorageStateToHosts`) and checks that the kernel would open it (`resolveIsolatedProviderStorageState`). It confirms the scoped session once more in a fresh browser context.
6. **Save.** It writes the session owner-only (0600) through `writePrivateStorageState` to `<state dir>/<vendor>-storage-state.json`. It refuses to write:
   - an empty session;
   - a session that holds the typed password, for example in a remembered-login cookie, including URL-encoded, base64 or inside a JSON value;
   - into a state directory with a symlinked component.

   It reads the file back through the kernel's own path resolver.
7. **Agent check.** It runs the GET-only check on the saved file. If that check cannot confirm the session, the outcome is `saved_unconfirmed`. That outcome is notified and makes the run exit non-zero, because agents would otherwise ask Blaine to log in to a vendor the tool reported as saved.

One writer at a time: `login:vendors` and `session:refresh` hold the same lock (`<state dir>/.vendor-session.lock`). A lock whose process is gone is taken over, and each holder re-reads the lock after taking it. Two runs that take over the same stale lock in the same instant are therefore narrowed to a lost-race refusal, not fully excluded.

### Stop conditions

The tool stops for that vendor and does nothing more when it sees any of these:

- a visible CAPTCHA or challenge in any frame. An invisible reCAPTCHA badge alone is not a stop.
- a second-factor prompt: a code field, or text asking you to approve the sign-in.
- an unknown page:
  - no sign-in form;
  - a sign-up or reset form;
  - an off-host redirect;
  - a redirected submission;
  - an unreachable page;
  - a landing page with no signed-in evidence.
- a failed login:
  - rejected credentials;
  - a locked account;
  - still on the form after the single submit;
  - a submission to an unreviewed host that was blocked.
- a session check that met a challenge or failed.

It never solves, bypasses or resubmits anything, and it uses no stealth or anti-detection measures. Each stop raises a macOS notification and writes one line to the status log. To recover by hand, run `npm --prefix worker run auth:vendor -- <vendor>`. It saves to the same `QUOTE_VENDOR_STORAGE_STATE_DIR` from `worker/.env`.

### Status log

The log is one line per vendor per run, at `~/Library/Logs/overdrafter/vendor-login.log` (0600):

```text
2026-10-23T06:30:12.000Z vendor=quickparts outcome=refreshed reason=authenticated_marker_found host=- kill_switch=disengaged check=valid:authenticated_marker_found
2026-10-23T06:30:40.000Z vendor=weerg outcome=stopped reason=captcha:visible_challenge host=www.weerg.com kill_switch=disengaged check=-
2026-10-23T06:31:05.000Z vendor=geomiq outcome=saved_unconfirmed reason=session_check_not_valid host=- kill_switch=disengaged check=login_required:no_authenticated_marker
```

Every value is fixed vocabulary or a host name. Usernames, item names, passwords, page text and URLs beyond the host are never written. Any value outside that vocabulary is printed as `redacted`. An older log is reset to 0600, and the tool refuses to write to a symlinked log.

The tool refuses to start when a diagnostic setting is present: `DEBUG`, `DEBUG_FILE`, `PWDEBUG`, `NODE_DEBUG`, or `NODE_OPTIONS=--inspect`. Playwright and Node diagnostics can print filled values and child-process environments. `session:check` and `session:refresh` refuse the same settings before they probe, because Playwright protocol logging in the parent process would print restored cookies and local-storage tokens. Browsers and the notifier start with a minimal environment that holds no Bitwarden session and no worker secrets.

## Choosing how Bitwarden unlocks

The tool supports two unlock modes. Set the mode in the login config.

- **`session-env` (default; manual runs).** Unlock in your own terminal first with `export BW_SESSION="$(bw unlock --raw)"`. Nothing is stored. Use this mode for the first run and for any run you watch.
- **`keychain` (unattended LaunchAgent).** The master password lives in the macOS login keychain. The tool reads it with `/usr/bin/security`, unlocks with `bw unlock --passwordenv` (the password goes in an environment variable, never in an argument), reads the items, and runs `bw lock` at the end.

Security tradeoff of `keychain` mode: when the keychain item trusts `/usr/bin/security`, any process running as your macOS user can read the master password without a prompt. That includes agent shells. Without that trust, macOS prompts on each read, and the LaunchAgent cannot run unattended. Limit what that password can unlock:

- **Recommended:** create a separate Bitwarden account that holds only the vendor portal logins, and use its master password here. If it leaks, only those vendor accounts are exposed, not your personal vault. Give that account its own CLI data directory with `BITWARDENCLI_APPDATA_DIR`, and add the same variable to the LaunchAgent's `EnvironmentVariables`.
- Never reuse a vendor password elsewhere, and do not enable TOTP on these items. A second-factor prompt stops the tool anyway.
- The Bitwarden API key (`bw login --apikey`) only logs the CLI in; it cannot decrypt the vault. You still need the master password to unlock.
- `bw lock` at the end of a keychain run also locks any `BW_SESSION` you exported in another terminal.

## First run (Blaine)

Run these steps in Terminal.app or iTerm. Do not run them from an agent's terminal panel, because the tripwire refuses agent environments.

1. Install the Bitwarden CLI, if `which bw` prints nothing:

   ```bash
   brew install bitwarden-cli
   ```

2. Log the CLI in once. Use the dedicated vendor-login account if you created one. The login persists, and only unlocking is needed later.

   ```bash
   bw login
   ```

3. Create one **Login** item per vendor in that vault. Each item needs the username, the password, and a URI on the vendor's host:
   - Quickparts: `https://quickquote.quickparts.com`
   - Geomiq: `https://app.geomiq.com`
   - Weerg: `https://www.weerg.com`

   Note each item's ID. The ID is unambiguous; an exact item name also works.

   ```bash
   export BW_SESSION="$(bw unlock --raw)"
   bw sync
   bw get item "<item name>" | jq -r .id
   ```

4. Write the login config outside the repository, owner-only. The tool refuses a config with group or other permission bits, a symlink, or a path that resolves inside any checkout of the repository.

   ```bash
   mkdir -p -m 700 ~/.config/overdrafter
   which bw
   ```

   Save the following as `~/.config/overdrafter/vendor-login.json`. Use the `which bw` output as `cliPath`: it is `/opt/homebrew/bin/bw` on Apple Silicon and `/usr/local/bin/bw` on Intel. Set `stateDir` to the directory in `QUOTE_VENDOR_STORAGE_STATE_DIR` in the main checkout's `worker/.env`, which is where the worker reads sessions.

   ```json
   {
     "stateDir": "~/Documents/GitHub/Overdrafter/worker/state",
     "headless": true,
     "bitwarden": {
       "cliPath": "/opt/homebrew/bin/bw",
       "unlock": "session-env"
     },
     "vendors": {
       "quickparts": { "item": "<quickparts item id>" },
       "geomiq": { "item": "<geomiq item id>" },
       "weerg": { "item": "<weerg item id>" }
     }
   }
   ```

   ```bash
   chmod 600 ~/.config/overdrafter/vendor-login.json
   ```

   A `--state-dir` flag or `QUOTE_VENDOR_STORAGE_STATE_DIR` takes precedence over `stateDir`. When the commands run from the main checkout, `worker/.env` supplies `QUOTE_VENDOR_STORAGE_STATE_DIR`.

5. Run once by hand from the main checkout, unlocked in this terminal, with the browser visible:

   ```bash
   export BW_SESSION="$(bw unlock --raw)"
   npm --prefix worker run login:vendors -- quickparts,geomiq,weerg --headed
   npm --prefix worker run session:check -- quickparts,geomiq,weerg
   ```

   Each vendor prints one status line. Read the outcome:
   - `outcome=saved` with `check=valid:...` is the goal.
   - If a vendor stops, the reason says where.
   - `saved_unconfirmed` means the login worked but the GET-only check could not confirm it. Report it, so the check for that portal can be tuned from a reviewed observation.

   If a headless run hits a CAPTCHA that a visible browser does not, set `"headless": false`.

6. For unattended runs, switch to keychain unlock. Store the master password; the command prompts for it, so it never appears in your shell history:

   ```bash
   security add-generic-password -s overdrafter-bitwarden -a overdrafter -T /usr/bin/security -w
   ```

   Then set the config's `bitwarden` block to:

   ```json
   { "cliPath": "/opt/homebrew/bin/bw", "unlock": "keychain", "keychainService": "overdrafter-bitwarden", "keychainAccount": "overdrafter" }
   ```

   Check it once by hand without `BW_SESSION`:

   ```bash
   unset BW_SESSION
   npm --prefix worker run login:vendors -- quickparts,geomiq,weerg
   ```

7. Load the LaunchAgent. It runs at 06:30 and 18:30, and launchd runs a missed time on wake. The log file is created first, so launchd appends to an owner-only file.

   ```bash
   mkdir -p -m 700 ~/Library/Logs/overdrafter
   mkdir -p ~/Library/LaunchAgents
   touch ~/Library/Logs/overdrafter/vendor-login.launchd.log
   chmod 600 ~/Library/Logs/overdrafter/vendor-login.launchd.log
   REPO="$HOME/Documents/GitHub/Overdrafter"
   sed -e "s|__REPO__|$REPO|g" -e "s|__NPM__|$(which npm)|g" -e "s|__NODE_BIN_DIR__|$(dirname "$(which node)")|g" -e "s|__HOME__|$HOME|g" "$REPO/worker/scripts/launchd/com.overdrafter.vendor-login.plist.template" > ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   plutil -lint ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   launchctl bootout "gui/$(id -u)/com.overdrafter.vendor-login" 2>/dev/null || true
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   launchctl kickstart -k "gui/$(id -u)/com.overdrafter.vendor-login"
   tail -n 20 ~/Library/Logs/overdrafter/vendor-login.log ~/Library/Logs/overdrafter/vendor-login.launchd.log
   ```

   Check these if the LaunchAgent run does not behave:
   - `bw` must sit in the same directory as `node` (true for Homebrew), or `cliPath` must be absolute.
   - If the LaunchAgent log says the tool needs an interactive terminal, launchd did not set `XPC_SERVICE_NAME` to the job label. Report it rather than editing the check.
   - If no notification appears when a vendor stops, allow notifications for Script Editor in System Settings > Notifications. `osascript` notifications are posted under Script Editor.

### Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.overdrafter.vendor-login"
rm ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
security delete-generic-password -s overdrafter-bitwarden -a overdrafter
```

## Files

| Path | Holds | Mode |
| -- | -- | -- |
| `~/.config/overdrafter/vendor-login.json` | Bitwarden item IDs, unlock mode, state directory | 0600, outside the repo |
| `<state dir>/<vendor>-storage-state.json` | Scoped Playwright session | 0600, gitignored `worker/state/` |
| `<state dir>/.vendor-session.lock` | One-writer lock shared by `login:vendors` and `session:refresh` | 0600 |
| `~/Library/Logs/overdrafter/vendor-login.log` | One scrubbed status line per vendor per run | 0600 |
| `~/Library/LaunchAgents/com.overdrafter.vendor-login.plist` | Rendered LaunchAgent, no secrets | user |

## When a portal defeats the heuristics

A `login_form_not_found`, `username_field_not_found` or `submit_control_unrecognized` stop means the generic form heuristics did not recognize the page. The fix is a selector hint in `VENDOR_LOGIN_OVERRIDES` in `worker/src/tools/vendorLoginFlow.ts`. Base the hint on a reviewed observation of the live page; observing the live portal is a protected action. Never commit captured page content. Edits to the `vendorLogin*` tools and the LaunchAgent template are sensitive paths (class `secrets`).
