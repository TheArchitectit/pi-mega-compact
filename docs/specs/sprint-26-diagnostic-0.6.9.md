# Sprint 26 — Diagnostic Snapshot: Confirmed Running 0.6.9

**Date:** 2026-07-17
**Purpose:** Prove the running pi-mega-compact extension is physically 0.6.9 — not just the `package.json` label — by grepping 0.6.9-only dashboard-enrichment markers in the loaded npm dist.

---

## 1. Confirmed-Running 0.6.9 — Evidence

### 1.1 Registry latest

```
$ npm view pi-mega-compact version
0.6.9
```

### 1.2 Installed package.json version

Path: `/home/user001/.pi/agent/npm/node_modules/pi-mega-compact/package.json`

```
  "version": "0.6.9",
```

### 1.3 Marker grep results (loaded npm dist)

Resolved root: `/home/user001/.pi/agent/npm/node_modules/pi-mega-compact`

#### `tokensKept` in `extensions/dashboard-server.ts` (5 matches)

```
74:  // from each repo's node:sqlite store at stateDir. tokensKept = Σ stored
78:  tokensKept: number;
122:      tokensKept: 0,
147:            repo.tokensKept = Number(tok.kept ?? 0);
857:      g.tokensOut += (r.tokensKept || 0);
```

#### `tokensKept` in `dist/extensions/dashboard-server.js` (runtime, 3 matches)

```
87:            tokensKept: 0,
110:                        repo.tokensKept = Number(tok.kept ?? 0);
746:      g.tokensOut += (r.tokensKept || 0);
```

#### `Savings by Model` marker (1 dist + 1 source match)

```
dist/extensions/dashboard-server.js:485:  <h2 ...>Savings by Model</h2>
extensions/dashboard-server.ts:596:  <h2 ...>Savings by Model</h2>
```

#### `savingsByModel` symbol

No standalone `savingsByModel` symbol found (0 matches). The 0.6.9 enrichment is expressed via the `tokensKept` field on repo aggregates + the `Savings by Model` card heading, not a `savingsByModel` variable. This is expected — absence does NOT contradict 0.6.9 since the other two markers are present in the runtime `dist/`.

### 1.4 Conclusion

[V] `tokensKept` is physically present in the loaded runtime file `dist/extensions/dashboard-server.js` (lines 87, 110, 746). [V] `Savings by Model` heading is physically present in `dist/extensions/dashboard-server.js:485`. The running code IS 0.6.9, beyond the `package.json` label.

---

## 2. Environment Snapshot

| Field | Value |
|---|---|
| git HEAD | `2a9c39ba5510498931ffd2c28126c8c2dbd88ae2` |
| branch | `feat/verify-s24` |
| node | `v26.1.0` |
| registry latest | `0.6.9` |
| installed package.json version | `0.6.9` |

### 2.1 Load mechanism (npm copy, not symlink)

```
$ readlink -f /home/user001/.pi/agent/npm/node_modules/pi-mega-compact
/home/user001/.pi/agent/npm/node_modules/pi-mega-compact
$ [ -L ... ] && echo SYMLINK || echo 'NOT symlink (npm copy)'
NOT symlink (npm copy)
```

[V] The installed extension is a real npm copy under `~/.pi/agent/npm/node_modules/`, not a dev symlink into `~/.pi/agent/extensions/`. This satisfies PREVENT-DIST-001: distribution is via the npm path. (Dev symlinks bypass the update path; not used here.)

### 2.2 MEGA environment variables

```
$ env | grep -i mega
(no MEGA* variables set)
```

Only `PWD=/mnt/data/git/pi-mega-compact` matched the case-insensitive `mega` substring (the repo path). No `MEGACOMPACT_*` toggles are set — defaults are in effect (node:sqlite sync store as authoritative, TrigramEmbedder default, PGlite async index best-effort).

---

## 3. Distribution Status

[V] 0.6.9 is already published to npm (`npm view` returns `0.6.9`). Per PREVENT-DIST-001, no `.tgz` tarball is produced and no dev symlink is relied upon. This snapshot documents verification only — no publish action is taken.

---

## 4. What This Snapshot Does NOT Cover

- Runtime behavior / live dashboard rendering (static grep only; no HTTP fetch of `/dashboard`).
- PGlite vector index state at `~/.pi/mega-compact-vector`.
- node:sqlite store contents under `~/.pi/mega-compact/`.
- Cross-device propagation (requires `pi update --extensions` on each device).

These are out of scope for the "confirmed running 0.6.9" proof; the marker grep + package.json + registry triple is sufficient.
