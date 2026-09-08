# Just Zen security

The maintained security explanation lives on the website: https://kierankeene122.github.io/just-zen/security.html (source: `docs/security.html`). The app's Privacy & data panel shows the live build status and holds the app lock and data controls.


Assessment date: 7 September 2026. Scope: Just Zen 0.3.0 for macOS, compared with the maintained Rambox product.

## Practical conclusion

Just Zen now has a stronger design than the earlier prototype: websites default to isolated profiles, application state is encrypted with Electron `safeStorage` backed by macOS Keychain, an optional Touch ID lock protects the visible interface, data-removal controls are built in, and Claude Chat runs behind Anthropic Sandbox Runtime’s macOS Seatbelt boundary. Sandboxing is fail-closed; Just Zen does not silently fall back to an unrestricted Claude Chat process.

Since 8 September 2026 releases are Developer ID signed and notarized by the `kierankeene122/just-zen` release workflow, and installed apps update themselves; Electron and dependency patches flow through Dependabot, CI and the auto-release workflow without manual steps. Just Zen has a different trust boundary from a plain web-app aggregator because Claude can act on an explicitly granted local workspace. Claude Terminal has the same macOS-user authority as running Claude Code in Terminal.app; Just Zen does not grant it additional privilege.

Just Zen should not be described as externally audited. The automated Claude Security workflow was unavailable in the implementation session, and no independent penetration-testing firm has reviewed it. CodeQL, dependency auditing, OS-boundary integration tests, and an audit scope are configured as preparation, not substitutes for external review.

## Controls in 0.3.0

| Area | Current control | Remaining limit |
| --- | --- | --- |
| Web sessions | New and previously unprofiled apps use stable per-app isolated partitions. Shared, Personal, and Work are explicit choices. OAuth children inherit the originating partition. | Deliberately grouped services share cookies and exposure. |
| Web renderer | Electron sandbox, context isolation, Node integration disabled, no Just Zen preload bridge, invalid TLS certificates and capture permissions rejected, native-app links constrained, and every download requires a native save confirmation. Notification permission is limited to secure origins loaded as saved apps; every other web permission remains denied. | A new Chromium vulnerability may exist before an update ships. |
| Claude Chat | Anthropic Sandbox Runtime 0.0.75 applies macOS Seatbelt rules to the complete Claude process tree. Claude runs with an app-owned `CLAUDE_CONFIG_DIR` under Just Zen's data folder; the user's personal `~/.claude`, `~/.claude.json`, the rest of the home folder, `/Users`, `/Volumes`, `/private/var/folders` and `/tmp` are denied; temporary files go to a private directory under Just Zen's data folder. Writes are allowlisted; Read-only denies workspace writes. Network access is allowlisted to Claude/Anthropic endpoints. A probe inside the sandbox refuses to start Claude if Seatbelt is not active. Tool hooks add path, resolved-symlink, Notes-only, MCP and approval checks; only the app-owned user settings are loaded and project MCP configuration is ignored. | The allowed workspace and the app-owned Claude login remain visible to the Claude process. Notes-only extension policy is enforced by the tool hook because Seatbelt cannot express Markdown-only writes. Project `CLAUDE.md` and project settings are not loaded in Chat. |
| Claude Terminal | Requires Full mode and stays visibly separate from Chat. It has the same macOS-user authority as Claude Code launched in Terminal.app. | The operational risk comes from letting an agent perform reviewed commands with that ordinary authority; Just Zen does not create additional OS privilege. Current Sandbox Runtime releases have known interactive TTY limitations on macOS. |
| Local app state | Settings, tasks, whiteboard content and Just Zen’s saved Claude conversations are encrypted using a Keychain-protected key. Legacy plaintext state is migrated and removed. | Data is decrypted while Just Zen is running. Backups or filesystem snapshots may retain older plaintext blocks. |
| App lock | Optional Touch ID or scrypt-hashed passcode unlock with 5–60 minute inactivity delay; packaged builds hide developer tools. Main-process IPC rejects protected operations while locked. The window is hidden until the lock screen is installed at startup. | It is a local privacy control, not a defence against malware already running as the user. |
| Data cleanup | Clear Shared, Personal, Work, or individual isolated browser data; clear Just Zen Claude history; or erase Just Zen settings, tasks, sessions, favicons and history. | Claude Code may keep its own separate history under its configuration directory. |
| Updates | Pinned Electron, immutable commit pins for third-party CI actions, weekly dependency updates, npm audit, CodeQL, OS-sandbox integration test, hardened runtime, notarization workflow, release artifact attestation, update checks every six hours, and downgrade rejection. | These protections become operational only after Apple/GitHub credentials are configured and a signed release is published. |

## Classification of the remaining statements

- **Claude changing an allowed workspace is an expected capability.** It is the same file-changing capability Claude Code has when launched locally. Just Zen Chat adds a narrower selected-folder boundary; it does not turn the underlying capability into a vulnerability.
- **Terminal inheriting the macOS user's permissions is expected behaviour.** Just Zen does not elevate it. The relevant safeguard is Claude Code's own command approval model.
- **Shared profiles are an explicit configuration choice.** They intentionally share login state. Isolated profiles are available for users who want separate accounts or a smaller session boundary.
- **Chromium patch delivery is a product security responsibility.** Signing authenticates a build but does not patch it. Just Zen must regularly upgrade Electron and deliver each signed build promptly. Mac App Store distribution is not required; a Developer ID signed and notarized direct build can use the configured update feed.
- **Malware already executing as the user is outside the app-lock boundary.** The lock protects against casual physical access to an open Mac. It cannot reliably isolate Just Zen from another process that the operating system already permits to inspect or control user applications.
- **The pending independent review is an assurance gap, not a discovered vulnerability.** Automated tests provide evidence for specific controls but do not replace a penetration test.

## Threat boundaries

- Website content never receives Just Zen’s privileged preload API and is never automatically copied into Claude prompts.
- Claude Chat receives only the selected workspace plus the minimum Claude configuration needed to authenticate and resume that workspace.
- Browser profiles and Claude run in separate process and storage boundaries.
- A compromised website may compromise its own account or exploit an unknown Chromium flaw. Isolation reduces the number of other accounts affected.
- A compromised or mistaken Claude operation may damage files its process can already access. In Terminal mode this is the same authority Claude Code receives in Terminal.app; the difference is agent automation, not elevated privilege. Backups and the Read-only policy remain useful safeguards.
- Malware already running as the signed-in macOS user may inspect screens, memory, files, or browser data regardless of Just Zen’s app lock.
- A compromised release account could distribute malicious updates. Protected tags, mandatory two-factor authentication and tightly scoped GitHub access remain release requirements.

## Release gate

A public daily-use release requires all of the following:

1. Developer ID signing and Apple notarization succeed in GitHub Actions.
2. Gatekeeper accepts the downloaded build and its stapled notarization ticket.
3. An update from one signed test version to the next succeeds through the production HTTPS feed.
4. CodeQL, dependency audit, unit tests, smoke tests and the Sandbox Runtime integration test pass.
5. An independent macOS/Electron penetration test covers the items in `AUDIT-SCOPE.md`; high and critical findings are fixed and retested.

## Changes from the 8 September 2026 code review

See `SECURITY-REVIEW-2026-09-08.md` for the findings. Fixes in this revision: Electron fuses hardened and app code packed into asar with integrity validation (helpers now run under a real Node.js binary, so `ELECTRON_RUN_AS_NODE` is no longer needed); Chat and Terminal use an app-owned Claude config directory; the sandbox denies `/Users`, `/Volumes`, temporary folders and other Claude projects; Notes-only checks the resolved target and refuses writes through symlinks; MCP tool names are never mapped onto built-in tools and project MCP configuration is ignored; favicons are decoded in a hidden sandboxed renderer; ad-hoc addresses use in-memory partitions and stale partitions are removed on erase; `--smoke` always uses a fresh temporary profile and `--smoke`/`HEARTH_DATA` are ignored when packaged; passcode unlock backs off after repeated failures; notification permission is limited to the saved app's landing origins; the `allow-unsigned-executable-memory` entitlement was removed.

## Sources

- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Claude Code sandboxing](https://docs.anthropic.com/en/docs/claude-code/sandboxing)
- [Rambox security](https://support.rambox.app/support/solutions/articles/42000107434-is-rambox-secure-or-safe-to-use-)
- [Rambox features](https://rambox.app/features/)

## Document containment
Documents render in a separate sandboxed WebContentsView, with Node integration disabled and a document-only preload. Main-process requests verify the exact document view and main-frame URL. The view has an ephemeral session, denies permissions, popups and navigation, and allows requests only for its bundled viewer assets. It cannot call the main app's Claude or filesystem bridge.

PDF writing and DOCX/RTF conversion run in a separate process under macOS sandbox-exec. It denies network access and defaults to denied filesystem access, allowing runtime resources and a private per-job directory. Only selected document bytes enter the job; only output bytes return. Conversion times out after 30 seconds and temporary files are removed on completion or failure. Failure to start the sandbox fails closed. Original files and temporary copies are not independently encrypted by this feature.
