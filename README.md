# Just Zen

A small launcher for macOS and Windows: a floating panel on the edge of your screen, and ⌥Space for everything else.

- **The panel** — the apps, web apps, groups and documents you flick between, above every app and on every Space. Drop a file on an app to open it there. Right-click to group things; a group folds behind one icon.
- **⌥Space** — one field over your installed applications, your documents (through Spotlight), a library of about a hundred web apps, any address you type, and the tabs already open in your browser. ⌘↵ pins a result to the panel.
- **Your browser stays yours** — web apps open in Safari or Chrome, whichever this machine opens links with, reusing the tab that already has the site open. Claude, Gemini, ChatGPT and Slack open through their own links.
- **Groups and order** — drag one icon onto another to group them, drag between two to reorder, drag anything into a group.

No account, no sync, no telemetry. Settings stay on your machine, encrypted with the Keychain where macOS allows it.

## Install

Download the latest build from [Releases](https://github.com/kierankeene122/just-zen/releases) — `Just-Zen-arm64.dmg` for Apple Silicon, `Just-Zen-Setup.exe` for Windows 10 and 11.

## Develop

```
npm install
npm start          # run it
npm test           # unit tests
npm run smoke      # end-to-end: config, finder, panel, order, windows, bridges
npm run release    # tag and push; CI builds and signs
```
