# Just Zen

A calm local workspace for Mac: your web apps, your files and notes, your documents and tasks, and Claude Code as a copilot, all in one window.

- Download: https://github.com/kierankeene122/just-zen/releases/latest/download/Just-Zen-arm64.dmg (Apple silicon, macOS 13 or later, signed and notarized)
- Security: see `SECURITY.md`, `SECURITY-REVIEW-2026-09-08.md` and the Security page inside the app.

## Licence and warranty

Just Zen is free, open-source software released under the ISC licence (see `LICENSE`). It is provided **as is, without warranty of any kind**, and the author accepts no liability for any loss or damage arising from its use. Inspect the code, decide for yourself, and keep backups of anything you connect to it.

## Development

```
npm ci
npm test
npm run smoke
npm run package        # local ad hoc build into ../../outputs
npm run release        # tag a version; GitHub builds the signed release
```
