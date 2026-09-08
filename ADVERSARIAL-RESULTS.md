# Targeted adversarial checks — 8 September 2026

Executed against isolated temporary profiles and synthetic local fixtures. This is an internal regression exercise, not an independent audit or a guarantee against unknown vulnerabilities.

## Finding fixed
Save copy compared destination paths by spelling only. A selected symlink or hardlink could refer to the original document and overwrite it. Reproduced with a TXT fixture. The destination is now opened without following symlinks, checked via its open file descriptor, and rejected if it is non-regular, multiply linked, or the original inode before truncation. Both reproductions now fail safely and leave the original unchanged.

## Results
- Claude policy rejects directory traversal, similarly named sibling directories, chained symlinks and new files underneath an escaping symlink.
- A real foreign Electron renderer with an instrumented IPC preload cannot invoke terminal startup, file read, app state, document open/save or Claude folder selection. Sender checks reject all six requests.
- Two real isolated browser sessions on the same local origin cannot see each other's cookies or local storage.
- File/data/native popup attempts cannot acquire privileged app access. Chromium may normalise a JavaScript popup to about:blank; that child retains sandbox=true, contextIsolation=true, nodeIntegration=false and the source profile. Allowed HTTP OAuth popup inherits only its source profile.
- Hostile document HTML containing scripts, event handlers, external images and local-file iframes is removed by the viewer sanitizer.
- A synthetic PDF containing a JavaScript OpenAction renders without executing the injected script.
- Separate existing checks verify the document viewer lacks the app bridge, blocks terminal actions and outbound fetch, and that the converter OS sandbox rejects unrelated file reads, writes and outbound TCP.

Validation: npm test: 35 passed, 1 skipped (optional Claude runtime integration). Electron smoke, including the adversarial fixtures: passed.

## Limits
No third-party services/accounts were attacked. This does not test every parser exploit, compression bomb, concurrent filesystem race, popup flood, browser zero-day or cookie channel. Claude model behaviour/prompt injection and an independent penetration test remain separate work. No production user data was used.
