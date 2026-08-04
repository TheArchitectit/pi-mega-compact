# Security and Privacy Contract

## Threat model and storage

Protect against other local users, accidental export/training, stale backups, corrupt assets, and offline dependency compromise. Not protected: root/admin, a compromised running process, or secrets already sent to a provider. State directories are created `0700`; files `0600`; startup rejects or repairs broader permissions with an audit event. Temporary files inherit these modes and are atomically renamed.

Optional encryption covers ledger payload bytes, exact/residual shards, compatibility journal, exports, and backups at rest; indexes/digests/lengths/timestamps remain metadata-visible. Keys come only from OS keychain or an explicit local key file outside state; never environment logs, npm assets, or fixtures. Encryption does not protect memory during use. Losing the key loses encrypted data; C may use only the current host transcript.

## Lifecycle

Default retention follows project policy; every new table declares retention class. Export is explicit, local, digest-manifested, permission `0600`, and warns that exact bytes may contain secrets. Deletion writes an auditable tombstone, removes derived artifacts/crystals, and schedules encrypted-key destruction or secure best-effort deletion; backups remain listed until their retention expiry. Backup/restore verifies permissions, encryption metadata, schema, sequence, and digests. Compatibility journal shares ledger retention.

The exact ledger preserves truth but is **never automatically training data**. Learning defaults to no user-content inclusion. Opt-in consent is append-only and records subject/session scope, purposes, dataset version, timestamp, policy version, and revocation. Revocation excludes future datasets and records affected digest manifests; immutable released datasets require documented withdrawal handling.

## Fixtures, datasets, telemetry

Conformance fixtures must be synthetic, secret-scanned, and contain no credentials, private prompts, production state, personal data, or copied user ledger. Dataset manifests satisfy [MODEL_ASSET](MODEL_ASSET.md): provenance, license, consent, digest, redaction, allowed use. Telemetry contains IDs/digests/counts, never payloads, tokens, authorization fields, or model inputs.

Security tests: permission creation/repair, encrypted backup round-trip/wrong-key failure, export/delete/retention, consent/revocation exclusion, and secret scanner over `conformance/vector-cortex/v2` plus assets/manifests. Runtime network-denial launches all A/B/C paths in a child process with patched `net`, `http`, `https`, `tls`, `dgram`, `dns` constructors throwing; local dashboard and explicitly configured loopback providers are separately fixture-bound exceptions. Static scans inspect TS/JS imports/calls and Rust Cargo.lock/source; violations fail, not warn.
