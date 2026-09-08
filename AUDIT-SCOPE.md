# Independent security review scope

This document is the brief for an external macOS and Electron security reviewer. Passing automated checks does not close this requirement.

## Required testing

1. Attempt to escape every website `WebContentsView` into Node, preload IPC, local files, sibling profiles, native application launches, arbitrary downloads, or opener windows.
2. Verify Shared, Personal, Work and per-app Isolated partitions do not leak cookies, storage, OAuth children, caches or credentials across their intended boundaries.
3. Attempt to bypass the Claude Seatbelt profile through symlinks, hard links, shell expansion, subprocesses, Unix sockets, Apple Events, local binding, network redirects, DNS rebinding and allowed-domain abuse.
4. Confirm Read-only prevents workspace mutation at the OS layer and assess the Notes-only hook for tool-name, MCP and malformed-input bypasses.
5. Review access to Claude authentication and project history; prove unrelated Claude project transcripts, SSH material, browser data and other home-directory content are denied.
6. Attempt to bypass Touch ID locking through renderer DevTools, IPC replay, navigation, crashes, accessibility APIs and startup races. Inspect memory and temporary-file handling.
7. Verify Keychain-backed encryption, legacy-state migration, file permissions and all cleanup controls. Check APFS snapshots and crash leftovers are described accurately.
8. Review updater origin validation, downgrade resistance, artifact signatures, notarization, GitHub Actions permissions, secret handling, tag protection and dependency supply-chain exposure.
9. Fuzz all renderer-to-main IPC parameters and file-resolution paths. Review denial and error paths for fail-open behaviour.
10. Compare the signed production build with the reviewed source and repeat Gatekeeper, notarization, update and sandbox tests on a clean Mac.

## Exit criteria

- No unresolved critical or high-severity findings.
- Medium findings have fixes or documented acceptance with a named owner.
- The reviewer retests fixes against the signed release candidate.
- The final report names the app version, source revision, macOS versions and hardware tested.
