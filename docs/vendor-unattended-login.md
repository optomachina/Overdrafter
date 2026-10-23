# Unattended vendor login (OVD-1060)

`login:vendors` signs in to vendor quote portals with credentials from Bitwarden, so Blaine is no longer the manual login step for each session under `worker/state/`. It covers Quickparts, Geomiq and Weerg. OSH Cut stays refused until OVD-1022.

## Who runs what

| Command | Who runs it | What it does |
| -- | -- | -- |
| `npm --prefix worker run login:vendors` | Blaine's terminal or his LaunchAgent only | Kill switch, session check, then one password login per vendor that needs it |
| `npm --prefix worker run session:check` | Anyone, agents included | Prints `valid`, `login_required`, `missing`, `unopenable_by_kernel` or `check_failed` per vendor |
| `npm --prefix worker run session:refresh` | Anyone, agents included | Reopens a still-valid session with GET requests only and re-saves it |

Agents never run `login:vendors`, never read the login config's Bitwarden items, never read the keychain, and never type a password or solve a CAPTCHA. `login:vendors` refuses to start when an agent runtime's environment markers are present, or when it has neither an interactive terminal nor its LaunchAgent. That check is a tripwire against an accidental run, not a security boundary.

Before a live run, an agent runs `session:check` for the vendors in that run. If any vendor is not `valid`, the agent sends Blaine one request that lists every vendor needing a login, instead of one request per vendor.

`check_failed` means the check itself could not decide, for example because of a challenge page, a 403 or a network failure. Logging in again may not fix it.

## What `login:vendors` does per vendor

1. **Kill switch.** When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set (the main checkout's `worker/.env`), it reads the provider kill switch. If the switch is engaged or cannot be read, the vendor is skipped. Without those credentials the switch is reported as `not_checked`.
2. **Session check.** It runs the same GET-only check as `session:check`. If the session is still valid, it re-saves the refreshed session and stops there, with no password and no vault unlock. `--force` skips this step.
3. **Credentials.** It unlocks Bitwarden at most once per run and reads the vendor's login item. The item must hold a URI on the vendor's reviewed hosts. Otherwise the tool refuses it, so a password saved for another site is never typed into a vendor page.
4. **Login.** It opens the workflow's `loginUrl` in Chromium and fills the form with generic heuristics. It handles a visible form, a sign-in button that opens a modal, and an email-first then password step. It types the password only into a visible main-frame field while the page is on a reviewed host, and it aborts any main-frame navigation to another host. It submits once.
5. **Confirmation.** It opens the vendor's landing page, the page the kernel opens first, and judges it with the vendor definition's own terminal-signal classifier. It scopes the session to the reviewed hosts (`scopeStorageStateToHosts`) and checks that the kernel would open it (`resolveIsolatedProviderStorageState`). It then confirms the scoped session again in a fresh browser context.
6. **Save.** It writes the session owner-only (0600) through `writePrivateStorageState` to `<state dir>/<vendor>-storage-state.json`. It then runs the GET-only check once and records the result as `check=` in the status line.

### Stop conditions

The tool stops for that vendor and does nothing more when it sees any of these:

- a visible CAPTCHA or challenge (an invisible reCAPTCHA badge alone is not a stop);
- a second-factor prompt;
- an unknown page: no sign-in form, an off-host redirect, an unreachable page, or an unexpected landing origin;
- a failed login: rejected credentials, a locked account, or still on the form after the single submit.

It never solves, bypasses or resubmits anything, and it uses no stealth or anti-detection measures. Each stop raises a macOS notification and writes one line to the status log. To recover by hand, run `npm --prefix worker run auth:vendor -- <vendor>`.

### Status log

The log is one line per vendor per run, at `~/Library/Logs/overdrafter/vendor-login.log` (0600):

```text
2026-10-23T06:30:12.000Z vendor=quickparts outcome=refreshed reason=authenticated_marker_found host=- kill_switch=disengaged check=valid:authenticated_marker_found
2026-10-23T06:30:40.000Z vendor=weerg outcome=stopped reason=captcha:visible_challenge host=www.weerg.com kill_switch=disengaged check=-
```

Every value is fixed vocabulary or a host name. Usernames, item names, passwords, page text and URLs beyond the host are never written. Any value outside that vocabulary is printed as `redacted`.

## Choosing how Bitwarden unlocks

The tool supports two unlock modes. Set the mode in the login config.

- **`session-env` (default; manual runs).** Unlock in your own terminal first with `export BW_SESSION="$(bw unlock --raw)"`. Nothing is stored. Use this mode for the first run and for any run you watch.
- **`keychain` (unattended LaunchAgent).** The master password lives in the macOS login keychain. The tool reads it with `/usr/bin/security`, unlocks with `bw unlock --passwordenv` (the password goes in an environment variable, never in an argument), reads the items, and runs `bw lock` at the end.

Security tradeoff of `keychain` mode: when the keychain item trusts `/usr/bin/security`, any process running as your macOS user can read the master password without a prompt. That includes agent shells. Without that trust, macOS prompts on each read, and the LaunchAgent cannot run unattended. Limit what that password can unlock:

- **Recommended:** create a separate Bitwarden account that holds only the vendor portal logins, and use its master password here. If it leaks, only those vendor accounts are exposed, not your personal vault.
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

4. Write the login config outside the repository, owner-only. The tool refuses a config with group or other permission bits, a symlink, or a path inside the checkout.

   ```bash
   mkdir -p ~/.config/overdrafter && chmod 700 ~/.config/overdrafter
   ```

   Save the following as `~/.config/overdrafter/vendor-login.json`:

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

   `stateDir` is used only when neither `--state-dir` nor `QUOTE_VENDOR_STORAGE_STATE_DIR` is set. Point it at the directory the worker reads sessions from.

5. Run once by hand from the main checkout, unlocked in this terminal, with the browser visible:

   ```bash
   export BW_SESSION="$(bw unlock --raw)"
   npm --prefix worker run login:vendors -- quickparts,geomiq,weerg --headed
   npm --prefix worker run session:check -- quickparts,geomiq,weerg
   ```

   Each vendor prints one status line. `outcome=saved` with `check=valid:...` is the goal. If a vendor stops, the reason says where. If a vendor saves but its `check=` is `login_required:no_authenticated_marker`, the GET-only check cannot confirm that portal yet. Report it, so its check can be tuned from a reviewed observation.

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

7. Load the LaunchAgent. It runs at 06:30 and 18:30, and launchd runs a missed time on wake.

   ```bash
   mkdir -p ~/Library/Logs/overdrafter
   REPO="$HOME/Documents/GitHub/Overdrafter"
   sed -e "s|__REPO__|$REPO|g" -e "s|__NPM__|$(which npm)|g" -e "s|__NODE_BIN_DIR__|$(dirname "$(which node)")|g" -e "s|__HOME__|$HOME|g" "$REPO/worker/scripts/launchd/com.overdrafter.vendor-login.plist.template" > ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   plutil -lint ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.overdrafter.vendor-login.plist
   launchctl kickstart -k "gui/$(id -u)/com.overdrafter.vendor-login"
   tail -n 20 ~/Library/Logs/overdrafter/vendor-login.log ~/Library/Logs/overdrafter/vendor-login.launchd.log
   ```

   `bw` must sit in the same directory as `node` (true for Homebrew), or `cliPath` must be absolute. If the LaunchAgent log says the tool needs an interactive terminal, launchd did not set `XPC_SERVICE_NAME` to the job label. Report it rather than editing the check.

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
| `~/Library/Logs/overdrafter/vendor-login.log` | One scrubbed status line per vendor per run | 0600 |
| `~/Library/Logs/overdrafter/vendor-login.lock` | Run lock so a manual run and the LaunchAgent never overlap | 0600 |
| `~/Library/LaunchAgents/com.overdrafter.vendor-login.plist` | Rendered LaunchAgent, no secrets | user |

## When a portal defeats the heuristics

A `login_form_not_found` or `username_field_not_found` stop means the generic form heuristics did not recognize the page. The fix is a selector hint in `VENDOR_LOGIN_OVERRIDES` in `worker/src/tools/vendorLoginFlow.ts`. Base the hint on a reviewed observation of the live page; observing the live portal is a protected action. Never commit captured page content.
