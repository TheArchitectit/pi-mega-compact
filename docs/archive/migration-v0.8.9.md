# Migration — v0.8.9

- Update: `npm install npm:pi-mega-compact` or `pi update --extensions`
- Build: `npm run build` + `npm run build:dashboard`
- Server: runs localhost; Tailscale optional (`TAILSCALE_ENABLED=1`)
- CSRF: PUT requests include token from `/api/csrf`
- No native module (`better-sqlite3`); uses `node:sqlite` (Node >=22.13)
- Rollback: `git revert <sha>` + `pi update --extensions`
