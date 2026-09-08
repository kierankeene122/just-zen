# Security update release setup

Just Zen checks its trusted GitHub Releases feed 15 seconds after launch and every six hours. It downloads a newer build in the background and installs it when the app quits. Development runs skip update checks.

## One-time setup

1. Join the Apple Developer Program and create a Developer ID Application certificate.
2. Create a public GitHub repository whose releases will be the trusted HTTPS update origin.
3. Set the GitHub Actions repository variables `HEARTH_GITHUB_OWNER` and `HEARTH_GITHUB_REPO`.
4. Add the signing secrets `CSC_LINK` and `CSC_KEY_PASSWORD`. `CSC_LINK` may contain a base64-encoded Developer ID Application certificate.
5. Add the notarization secrets `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. `APPLE_API_KEY` contains the App Store Connect private key text.
6. Change the package version, commit it, and push a matching tag such as `v0.3.0`. The release workflow tests, signs, notarizes, attests, and publishes the DMG, ZIP, update metadata, and blockmaps to GitHub Releases.

A release is cut on demand with `npm run release` (patch) or `npm run release -- minor`; the tag triggers the signed build. Dependabot updates are merged automatically after checks pass but never build on their own. Only the release workflow should be allowed to write releases. Protect tags and restrict who can change the workflow. Test the first update with a separate repository before relying on it. Just Zen refuses prerelease and downgrade updates. An updater does not update Electron independently: Dependabot raises Electron dependency updates, then the change must pass tests and be released as a complete signed app update.

The current prototype bundle was produced by Electron Packager and has no embedded feed. It remains a local development build. The signed build produced by the release workflow contains the update configuration.

For a local signed build without publishing, set `HEARTH_GITHUB_OWNER` and `HEARTH_GITHUB_REPO`, then run `npm run dist`. For a manual release, also set `GH_TOKEN` and run `npm run dist:publish`.

## Local automation (no Apple account)

Until a signed release feed exists, Electron patches are applied locally by `scripts/update-electron.cjs`, installed as the launchd agent `com.hearth.justzen.update` (`npm run update:agent`, `--remove` to uninstall). It runs at login and daily at 09:30, and launchd runs a missed slot when the Mac wakes.

Each run: swaps in any build staged earlier if Just Zen is closed; asks npm for the newest Electron in the current major; if newer than the installed one, installs it, rebuilds `node-pty`, runs `npm test` and `npm run smoke` (a window appears for a few seconds), packages into `outputs/staging`, and moves the result into `outputs/Just Zen-darwin-arm64` when Just Zen is closed, keeping the old bundle as `Just Zen.app.previous`. If anything fails the previous Electron version is restored and a macOS notification points at `~/Library/Logs/Just Zen/update.log`. A newer Electron major is reported on the Security page but never applied automatically, because majors can break native modules and the sandbox.

State lives in `~/Library/Application Support/Hearth/update-state.json`; the Security page's "Update channel" line reads it. `npm run update:electron -- --force` rebuilds on demand.
