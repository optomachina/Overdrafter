# iOS TestFlight Release

Portfolio status: deferred. This is a technical reactivation runbook, not an
active release plan. `PLAN.md` owns the current queue and `ROADMAP.md` owns any
future promotion of native iOS work.

This runbook is the source of truth for archiving and uploading the OverDrafter iOS app. It keeps credentials out of the
repository and separates the binary upload from the additional work required for an external-testing public link.

## Release identity

- App name: `OverDrafter`
- Bundle ID: `com.optomachina.overdrafter`
- Apple team ID: `CNCDUB33GL`
- Primary language: English (U.S.)
- SKU: `OVERDRAFTER-IOS-1`
- App Store Connect user access: Full Access
- Production origin: `https://overdrafter.vercel.app`
- Version source: `ios/Configurations/Base.xcconfig`
- Export configuration: `ios/ExportOptions-TestFlight.plist`

The export configuration uses `app-store-connect` with `destination = upload`. It intentionally leaves
`testFlightInternalTestingOnly` false so the uploaded build remains eligible for external testing and a public link.
It does not contain credentials.

## Current release gate

Xcode 26.4.1 satisfies Apple's current submission-tool requirement. The project, bundle identifier, icon, launch assets,
production URL, version, and unsigned generic-device Release build have been verified.

A signed archive cannot currently be created because no Apple account is signed in to Xcode and there is no provisioning
profile for `com.optomachina.overdrafter`. Before retrying:

1. Sign in under **Xcode → Settings → Accounts** with access to team `CNCDUB33GL`.
2. Confirm the Apple Developer Program membership is active and the Account Holder has accepted the latest agreement.
3. Confirm an explicit App ID and App Store Connect app record exist for `com.optomachina.overdrafter`.
4. Confirm build `1` is unused, or increment `CURRENT_PROJECT_VERSION` before archiving.

Apple also supports authenticating `xcodebuild` with an App Store Connect API key by supplying
`-authenticationKeyPath`, `-authenticationKeyID`, and `-authenticationKeyIssuerID`. Never commit the key or put its
contents in command output.

## Archive and upload

Run this complete block from the repository root. It regenerates the checked-in Xcode project, confirms it has no
unexpected diff, creates a fresh release directory, archives the app, and uploads it:

```sh
cd ios
xcodegen generate
git diff --exit-code -- OverDrafter.xcodeproj

release_base="${TMPDIR:-/tmp}"
release_root=$(mktemp -d "${release_base%/}/overdrafter-ios.XXXXXX")
archive_path="$release_root/OverDrafter.xcarchive"
export_path="$release_root/export"

xcodebuild \
  -project OverDrafter.xcodeproj \
  -scheme OverDrafter \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=CNCDUB33GL \
  archive

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist ExportOptions-TestFlight.plist \
  -allowProvisioningUpdates
```

Because the export destination is `upload`, a successful second command sends the build to App Store Connect. Preserve
the command output and archive path as release evidence. An uploaded build is immutable; fix rejected binaries by
incrementing `CURRENT_PROJECT_VERSION`, rebuilding, and uploading a new build.

## External TestFlight and public link

Uploading a binary does not create a public link. After App Store Connect finishes processing the build:

1. Resolve export compliance. `ITSAppUsesNonExemptEncryption` is currently false and is valid only while the app uses no
   custom encryption beyond exempt operating-system facilities such as TLS.
2. Create the required internal testing group, then create an external testing group.
3. Enter a Beta App Description, Feedback Email, and per-build **What to Test**.
4. Provide the reviewer contact details and a full-access demo account. Store credentials only in App Store Connect.
5. Keep the production backend available and provide representative sample files or instructions needed to exercise the
   upload and quote-comparison flow.
6. Submit the first build/version for Beta App Review.
7. After the approved build is available in the external group, choose **Create Public Link**, set an intentional tester
   limit, and verify installation from a device that is not signed in as an App Store Connect user.

Suggested beta copy:

> Upload manufacturing parts, organize quote requests, and compare supplier offers by total price and ready-to-ship lead
> time from one Parts, Quotes, and Search workspace.

Suggested **What to Test**:

> Sign in with the supplied review account. Open Parts, upload a representative CAD or drawing file, review the extracted
> part information, open Quotes, and compare available offers on the price-versus-lead-time scatter chart. Verify Search
> updates while typing and that external supplier links open outside the app.

## Policy-owned requirements before external review

Do not submit invented or placeholder policy answers. The product owner must confirm:

- a live public Privacy Policy URL, linked inside the app;
- a live Support URL and monitored feedback email;
- a full data-retention and processor inventory, including first-party web-view collection;
- the exact entire-account-deletion path and fulfillment timing;
- review contact information and demo credentials.

The current web experience allows account creation but does not offer full-account deletion. Apple requires deletion to
be initiable in the app; a direct link to the exact deletion page is acceptable, while deactivation or a generic support
email is not. Founding Beta policy revision `founding-beta-2026-08-15` provides public Terms and Privacy/data-handling
routes plus the monitored `support@overdrafter.com` address, but it does not close the in-app account-deletion or full
processor-inventory requirements for external App Store review. Those remain external-review blockers even though they
do not prevent a properly signed binary from uploading or being used by internal testers.

Likely privacy-inventory categories, subject to confirmation, include account identifiers, uploaded CAD/PDF content,
quote and request content, searches, purchase history, product interaction, and diagnostics. Apple's disclosures include
data collected through first-party web views. The empty native privacy manifest is not evidence that the service collects
no data.

## Verification after installation

- Install from the TestFlight invitation or public link on both an iPhone and iPad.
- Confirm the installed version and build match App Store Connect.
- Sign in with email/password and verify sign-out.
- Upload a non-sensitive sample file and confirm it appears in Parts.
- Open Quotes and verify price/lead-time comparison and offer selection.
- Verify Search updates while typing.
- Verify external links leave the app and unsupported schemes are blocked.
- Exercise offline, retry, download, and file-picker states.
- Record the install link and smoke-test evidence in the associated promoted
  Linear issue and its pull-request artifacts.

## Apple references

- [Upcoming submission requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Create an App Store Connect app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
- [Distribute through Xcode](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Provide TestFlight information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information)
- [Invite external testers and create a public link](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)
- [Export compliance for beta builds](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Account-deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [App Privacy details, including web views](https://developer.apple.com/app-store/app-privacy-details/)
