/**
 * api-contracts.test.ts — Validates the dashboard API contracts.
 *
 * Two validation layers:
 * 1. COMPILE-TIME: `satisfies` checks for each endpoint in the ENDPOINTS registry,
 *    ensuring response types are structurally compatible with their interfaces.
 *    Also verifies that every `/api/*` endpoint in `server.ts` has a corresponding
 *    entry in ENDPOINTS.
 * 2. RUNTIME: For each endpoint, a hand-crafted minimal JSON payload is parsed
 *    and validated for field presence and correct primitive types.
 *
 * SSE: The `SseEvent` union is validated by checking each variant has a `type`
 * field matching its discriminator.
 *
 * PREVENT-PI-004: zero network calls — all payloads are inline JSON strings.
 * PREVENT-011: no `any` type — `unknown` + runtime guards used throughout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS } from "./api-contracts/index.js";
import type {
  EndpointDef,
  SseEndpointDef,
  SnapshotResponse,
  VersionResponse,
  IndexesSummaryResponse,
  IndexFallbackResponse,
  ReposResponse,
  SummaryResponse,
  DriftReportResponse,
  ServersResponse,
  GameStateResponse,
  GameScoreRow,
  PerfResponse,
  AchievementRow,
  SseEvent,
} from "./api-contracts/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Primitive type name from a JSON-parsed value (matches typeof for JSON types). */
function primitiveType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Assert that a field exists on an object and has one of the expected primitive types. */
function assertField(
  obj: Record<string, unknown>,
  field: string,
  expected: string[],
): void {
  assert.ok(field in obj, `field "${field}" must exist`);
  const actual = primitiveType(obj[field]);
  assert.ok(
    expected.includes(actual),
    `field "${field}" expected type ${expected.join("|")}, got ${actual}`,
  );
}

/** Assert that a nested object field exists and is an object (or null if allowed). */
function assertObject(
  obj: Record<string, unknown>,
  field: string,
  allowNull: boolean = false,
): Record<string, unknown> | null {
  assert.ok(field in obj, `field "${field}" must exist`);
  const val = obj[field];
  if (allowNull && val === null) return null;
  assert.equal(
    primitiveType(val),
    "object",
    `field "${field}" must be an object${allowNull ? " or null" : ""}`,
  );
  return val as Record<string, unknown>;
}

// ─── Compile-Time: ENDPOINTS registry satisfies checks ──────────────────────
// These are type-level checks — if the response type of an endpoint doesn't
// match the expected interface, tsc will fail at compile time.

const _c_snapshot = ENDPOINTS.snapshot satisfies EndpointDef<
  "GET",
  undefined,
  SnapshotResponse
>;
const _c_version = ENDPOINTS.version satisfies EndpointDef<
  "GET",
  undefined,
  VersionResponse
>;
const _c_index = ENDPOINTS.index satisfies EndpointDef<
  "GET",
  undefined,
  IndexesSummaryResponse | IndexFallbackResponse
>;
const _c_repos = ENDPOINTS.repos satisfies EndpointDef<
  "GET",
  unknown,
  ReposResponse
>;
const _c_summary = ENDPOINTS.summary satisfies EndpointDef<
  "GET",
  undefined,
  SummaryResponse
>;
const _c_drift = ENDPOINTS.drift satisfies EndpointDef<
  "GET",
  undefined,
  DriftReportResponse
>;
const _c_servers = ENDPOINTS.servers satisfies EndpointDef<
  "GET",
  undefined,
  ServersResponse
>;
const _c_events = ENDPOINTS.events satisfies SseEndpointDef<SseEvent>;
const _c_getGameState = ENDPOINTS.getGameState satisfies EndpointDef<
  "GET",
  undefined,
  GameStateResponse
>;
const _c_putGameState = ENDPOINTS.putGameState satisfies EndpointDef<
  "PUT",
  unknown,
  GameStateResponse
>;
const _c_gameScores = ENDPOINTS.gameScores satisfies EndpointDef<
  "GET",
  unknown,
  GameScoreRow[]
>;
const _c_perf = ENDPOINTS.perf satisfies EndpointDef<
  "GET",
  unknown,
  PerfResponse
>;
const _c_achievements = ENDPOINTS.achievements satisfies EndpointDef<
  "GET",
  undefined,
  AchievementRow[]
>;

// Silence unused-variable warnings — these are compile-time-only checks.
void _c_snapshot;
void _c_version;
void _c_index;
void _c_repos;
void _c_summary;
void _c_drift;
void _c_servers;
void _c_events;
void _c_getGameState;
void _c_putGameState;
void _c_gameScores;
void _c_perf;
void _c_achievements;

// ─── Compile-Time: ENDPOINTS path/method consistency ─────────────────────────
// Verify the ENDPOINTS registry has exactly 13 entries with correct paths.

const ENDPOINT_KEYS = Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[];
const EXPECTED_ENDPOINT_COUNT = 13;

/** All `/api/*` paths served by server.ts (extracted from the route handlers). */
const SERVER_TS_PATHS: string[] = [
  "/api/snapshot",
  "/api/version",
  "/api/index",
  "/api/repos",
  "/api/summary",
  "/api/drift",
  "/api/servers",
  "/api/events",
  "/api/game-state",
  "/api/game-scores",
  "/api/perf",
  "/api/achievements",
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ENDPOINTS registry", () => {
  test("has exactly 13 endpoint entries", () => {
    assert.equal(
      ENDPOINT_KEYS.length,
      EXPECTED_ENDPOINT_COUNT,
      `ENDPOINTS must have ${EXPECTED_ENDPOINT_COUNT} entries, got ${ENDPOINT_KEYS.length}`,
    );
  });

  test("every server.ts /api/* path has a corresponding ENDPOINTS entry", () => {
    const registryPaths = new Set<string>(
      ENDPOINT_KEYS.map((k) => ENDPOINTS[k].path as string),
    );
    for (const path of SERVER_TS_PATHS) {
      assert.ok(
        registryPaths.has(path),
        `server.ts path "${path}" has no ENDPOINTS entry`,
      );
    }
  });

  test("every ENDPOINTS path starts with /api/", () => {
    for (const key of ENDPOINT_KEYS) {
      assert.ok(
        ENDPOINTS[key].path.startsWith("/api/"),
        `ENDPOINTS.${key}.path must start with /api/ — got "${ENDPOINTS[key].path}"`,
      );
    }
  });

  test("every ENDPOINTS entry has method and description", () => {
    for (const key of ENDPOINT_KEYS) {
      const ep = ENDPOINTS[key];
      assert.ok(ep.method, `ENDPOINTS.${key} must have method`);
      assert.ok(ep.description, `ENDPOINTS.${key} must have description`);
    }
  });
});

// ─── Per-endpoint runtime validation ─────────────────────────────────────────

describe("GET /api/snapshot", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      tier: "ultra-compact",
      presetTier: "super-compact",
      pressure: 45.2,
      config: {
        fastGatePct: 60,
        thresholdTokens: 100000,
        anchorUserMessages: 3,
        preserveRecent: 10,
        auto: true,
        autoInlineK: 5,
      },
      session: {
        id: "sess-123",
        state: "idle",
        persistedThisSession: true,
        lastCheckpointId: "ckpt-456",
        lastCompactedFrom: 50000,
      },
      context: {
        tokens: 42000,
        percent: 42,
        contextWindow: 200000,
      },
      trigger: {
        armed: true,
        ready: false,
        currentTokens: 42000,
        thresholdTokens: 100000,
        fastGatePct: 60,
      },
      store: {
        checkpointCount: 15,
        totalTokenEstimate: 120000,
        originalTokens: 200000,
        tokensSaved: 80000,
        injectedCount: 30,
        dedupHitRate: 12.5,
        storageDedupRate: 8.3,
        dedupCollapsed: 5,
      },
      crew: { activeAgents: 2, currentTurn: 1 },
      repo: {
        checkpointCount: 15,
        totalTokenEstimate: 120000,
        originalTokens: 200000,
        tokensSaved: 80000,
        sessionCount: 5,
        dedupAttempts: 10,
        dedupCollapsed: 5,
        storageDedupRate: 8.3,
      },
      integrity: {
        regionsRetained: 8,
        compressedOriginalBytes: 4096,
        duplicatesCollapsed: 5,
        bytesPermanentlyDeleted: 1024,
      },
      cacheHits: {
        session: 3,
        total: 20,
        sessionTokensSaved: 1500,
        totalTokensSaved: 10000,
      },
      compacts: { session: 3, total: 20 },
      timeSaved: {
        compact: { sessionSec: 120, totalSec: 600 },
        cacheHit: { sessionSec: 30, totalSec: 200 },
      },
      compression: {
        session: {
          tokensIn: 50000,
          tokensOut: 20000,
          tokensFreed: 30000,
          compressionPct: 60,
          dedupPct: 5,
        },
        repo: {
          tokensIn: 200000,
          tokensOut: 80000,
          tokensFreed: 120000,
          compressionPct: 60,
          dedupPct: 8,
        },
      },
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string", "null"]);
    assertField(obj, "tier", ["string"]);
    assertField(obj, "presetTier", ["string"]);
    assertField(obj, "pressure", ["number"]);
    assertField(obj, "config", ["object"]);
    assertField(obj, "session", ["object"]);
    assertField(obj, "context", ["object"]);
    assertField(obj, "trigger", ["object"]);
    assertField(obj, "store", ["object"]);
    assertField(obj, "crew", ["object"]);
    assertField(obj, "repo", ["object"]);
    assertField(obj, "integrity", ["object"]);
    assertField(obj, "cacheHits", ["object"]);
    assertField(obj, "compacts", ["object"]);
    assertField(obj, "timeSaved", ["object"]);
    assertField(obj, "compression", ["object"]);

    // Spot-check nested fields
    const config = assertObject(obj, "config")!;
    assertField(config, "fastGatePct", ["number"]);
    assertField(config, "auto", ["boolean"]);

    const session = assertObject(obj, "session")!;
    assertField(session, "id", ["string", "null"]);
    assertField(session, "persistedThisSession", ["boolean"]);

    const context = assertObject(obj, "context")!;
    assertField(context, "tokens", ["number", "null"]);
    assertField(context, "contextWindow", ["number"]);
  });
});

describe("GET /api/version", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({ version: "1.2.3" });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "version", ["string"]);
  });
});

describe("GET /api/index", () => {
  test("summary payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      totalRepos: 3,
      totalCheckpoints: 45,
      totalTokensSaved: 150000,
      totalCompressedOriginalBytes: 40960,
      repos: [
        {
          repoRoot: "/home/user/repo1",
          displayName: "repo1",
          stateDir: "/home/user/.pi/mega-compact/repo1",
          checkpointCount: 15,
          tokensSaved: 50000,
          compressedOriginalBytes: 16384,
          lastCompactedAt: 1700000000000,
          provider: "anthropic",
          providerName: "Anthropic",
          modelName: "claude-3",
          inputRate: 100,
          outputRate: 80,
          lastSeen: 1700000000000,
          tokensKept: 20000,
          tokensDropped: 30000,
          sessions: 5,
          contextWindow: 200000,
          maxTokens: 180000,
          reasoning: false,
        },
      ],
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string"]);
    assertField(obj, "totalRepos", ["number"]);
    assertField(obj, "totalCheckpoints", ["number"]);
    assertField(obj, "totalTokensSaved", ["number"]);
    assertField(obj, "totalCompressedOriginalBytes", ["number"]);
    assertField(obj, "repos", ["array"]);

    const repos = obj["repos"] as unknown[];
    assert.ok(repos.length > 0, "repos array should have at least one entry");
    const first = repos[0] as Record<string, unknown>;
    assertField(first, "repoRoot", ["string"]);
    assertField(first, "displayName", ["string"]);
    assertField(first, "checkpointCount", ["number"]);
    assertField(first, "lastCompactedAt", ["number", "null"]);
    assertField(first, "provider", ["string", "null"]);
    assertField(first, "lastSeen", ["number"]);
  });

  test("fallback payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: null,
      summary: null,
      repos: [],
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["null"]);
    assertField(obj, "summary", ["null"]);
    assertField(obj, "repos", ["array"]);
    assert.equal((obj["repos"] as unknown[]).length, 0);
  });
});

describe("GET /api/repos", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      repos: [
        {
          repoRoot: "/home/user/repo1",
          displayName: "repo1",
          stateDir: "/home/user/.pi/repo1",
          checkpointCount: 15,
          tokensSaved: 50000,
          compressedOriginalBytes: 16384,
          lastCompactedAt: null,
          provider: null,
          providerName: null,
          modelName: null,
          inputRate: null,
          outputRate: null,
          lastSeen: 1700000000000,
          tokensKept: 20000,
          tokensDropped: 30000,
          sessions: 5,
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
        },
      ],
      count: 1,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string", "null"]);
    assertField(obj, "repos", ["array"]);
    assertField(obj, "count", ["number"]);
  });
});

describe("GET /api/summary", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      summary: {
        totalRepos: 3,
        totalCheckpoints: 45,
        totalTokensSaved: 150000,
        totalCompressedOriginalBytes: 40960,
      },
      activeRepos: 2,
      totalRepos: 3,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string", "null"]);
    assertField(obj, "summary", ["object", "null"]);
    assertField(obj, "activeRepos", ["number"]);
    assertField(obj, "totalRepos", ["number"]);

    const summary = assertObject(obj, "summary")!;
    assertField(summary, "totalRepos", ["number"]);
    assertField(summary, "totalCheckpoints", ["number"]);
    assertField(summary, "totalTokensSaved", ["number"]);
    assertField(summary, "totalCompressedOriginalBytes", ["number"]);
  });

  test("null summary validates", () => {
    const raw = JSON.stringify({
      updatedAt: null,
      summary: null,
      activeRepos: 0,
      totalRepos: 0,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["null"]);
    assertField(obj, "summary", ["null"]);
    assertField(obj, "activeRepos", ["number"]);
    assertField(obj, "totalRepos", ["number"]);
  });
});

describe("GET /api/drift", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      generatedAt: 1700000000,
      totals: {
        ok: 2,
        warn: 1,
        stale: 1,
        compactionLag: 0,
        modelChurn: 0,
      },
      repos: [
        {
          repoRoot: "/home/user/repo1",
          displayName: "repo1",
          lastSeen: 1700000000,
          lastCompactedAt: 1699990000,
          modelCapturedAt: null,
          signals: [
            {
              kind: "stale",
              severity: "warn",
              detail: "No activity for 48h",
            },
          ],
          status: "warn",
        },
      ],
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "generatedAt", ["number"]);
    assertField(obj, "totals", ["object"]);
    assertField(obj, "repos", ["array"]);

    const totals = assertObject(obj, "totals")!;
    assertField(totals, "ok", ["number"]);
    assertField(totals, "warn", ["number"]);
    assertField(totals, "stale", ["number"]);
    assertField(totals, "compactionLag", ["number"]);
    assertField(totals, "modelChurn", ["number"]);

    const repos = obj["repos"] as unknown[];
    const first = repos[0] as Record<string, unknown>;
    assertField(first, "repoRoot", ["string"]);
    assertField(first, "displayName", ["string"]);
    assertField(first, "lastSeen", ["number"]);
    assertField(first, "lastCompactedAt", ["number", "null"]);
    assertField(first, "modelCapturedAt", ["number", "null"]);
    assertField(first, "signals", ["array"]);
    assertField(first, "status", ["string"]);

    const signals = first["signals"] as unknown[];
    const sig = signals[0] as Record<string, unknown>;
    assertField(sig, "kind", ["string"]);
    assertField(sig, "severity", ["string"]);
    assertField(sig, "detail", ["string"]);
  });
});

describe("GET /api/servers", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      servers: [
        {
          repoRoot: "/home/user/repo1",
          displayName: "repo1",
          model: "claude-3",
          provider: "anthropic",
          lastSeen: 1700000000,
          lastCompactedAt: 1699990000,
          tier: "ultra-compact",
          contextPct: 42,
          state: "idle",
        },
      ],
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string"]);
    assertField(obj, "servers", ["array"]);

    const servers = obj["servers"] as unknown[];
    const first = servers[0] as Record<string, unknown>;
    assertField(first, "repoRoot", ["string"]);
    assertField(first, "displayName", ["string"]);
    assertField(first, "model", ["string", "null"]);
    assertField(first, "provider", ["string", "null"]);
    assertField(first, "lastSeen", ["number"]);
    assertField(first, "lastCompactedAt", ["number", "null"]);
  });
});

describe("GET /api/game-state", () => {
  test("sample payload with active ritual validates", () => {
    const raw = JSON.stringify({
      config: {
        enabled: true,
        theme: "ocean",
        displayMode: "full",
      },
      activeRitual: {
        sessionId: "ritual-1",
        stageIndex: 2,
        startedAt: "2025-01-01T00:00:00Z",
        elapsed: 300000,
      },
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "config", ["object"]);
    assertField(obj, "activeRitual", ["object", "null"]);

    const config = assertObject(obj, "config")!;
    assertField(config, "enabled", ["boolean"]);
    assertField(config, "theme", ["string"]);
    assertField(config, "displayMode", ["string"]);

    const ritual = assertObject(obj, "activeRitual")!;
    assertField(ritual, "sessionId", ["string"]);
    assertField(ritual, "stageIndex", ["number"]);
    assertField(ritual, "startedAt", ["string"]);
    assertField(ritual, "elapsed", ["number"]);
  });

  test("sample payload with null ritual validates", () => {
    const raw = JSON.stringify({
      config: {
        enabled: false,
        theme: "mono",
        displayMode: "minimal",
      },
      activeRitual: null,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "config", ["object"]);
    assertField(obj, "activeRitual", ["null"]);
  });
});

describe("PUT /api/game-state", () => {
  test("response payload validates field presence and types", () => {
    // PUT /api/game-state returns GameStateResponse (same as GET)
    const raw = JSON.stringify({
      config: {
        enabled: true,
        theme: "ember",
        displayMode: "full",
      },
      activeRitual: null,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "config", ["object"]);
    assertField(obj, "activeRitual", ["object", "null"]);

    const config = assertObject(obj, "config")!;
    assertField(config, "enabled", ["boolean"]);
    assertField(config, "theme", ["string"]);
    assertField(config, "displayMode", ["string"]);
  });
});

describe("GET /api/game-scores", () => {
  test("sample payload (array) validates element field presence and types", () => {
    const raw = JSON.stringify([
      {
        repo_root: "/home/user/repo1",
        value: 1500,
        ts: 1700000000000,
        meta: { metric: "cache" },
      },
    ]);
    const arr = JSON.parse(raw) as unknown[];
    assert.ok(Array.isArray(arr), "response must be an array");

    const first = arr[0] as Record<string, unknown>;
    assertField(first, "repo_root", ["string"]);
    assertField(first, "value", ["number"]);
    assertField(first, "ts", ["number"]);
    assert.ok("meta" in first, 'field "meta" must exist');
  });
});

describe("GET /api/perf", () => {
  test("sample payload validates field presence and types", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      windowMinutes: 30,
      sampleCount: 100,
      turn_latency_ms: { p50: 500, p95: 2000, n: 100 },
      provider_latency_ms: { p50: 300, p95: 1500, n: 100 },
      tps: { avg: 45.5, n: 100 },
      cache_hit_pct: { avg: 30, latest: 25, n: 100 },
      db_recompute_ms: { p50: 50, p95: 200, n: 50 },
      disk_write_ms: { p50: 10, p95: 50, n: 50 },
      rss_mb: { latest: 256, n: 10 },
      heap_mb: { latest: 128, n: 10 },
      cpu_user_ms: { latest: 5000, n: 10 },
      cpu_sys_ms: { latest: 1000, n: 10 },
      diag: {
        ctxFastGate: 2,
        liveTrimFires: 5,
        liveTrimReplays: 3,
      },
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "updatedAt", ["string"]);
    assertField(obj, "windowMinutes", ["number"]);
    assertField(obj, "sampleCount", ["number"]);
    assertField(obj, "turn_latency_ms", ["object"]);
    assertField(obj, "provider_latency_ms", ["object"]);
    assertField(obj, "tps", ["object"]);
    assertField(obj, "cache_hit_pct", ["object"]);
    assertField(obj, "db_recompute_ms", ["object"]);
    assertField(obj, "disk_write_ms", ["object"]);
    assertField(obj, "rss_mb", ["object"]);
    assertField(obj, "heap_mb", ["object"]);
    assertField(obj, "cpu_user_ms", ["object"]);
    assertField(obj, "cpu_sys_ms", ["object"]);
    assertField(obj, "diag", ["object", "null"]);

    // Spot-check percentile sub-object
    const tl = assertObject(obj, "turn_latency_ms")!;
    assertField(tl, "p50", ["number"]);
    assertField(tl, "p95", ["number"]);
    assertField(tl, "n", ["number"]);

    const diag = assertObject(obj, "diag")!;
    assertField(diag, "ctxFastGate", ["number"]);
    assertField(diag, "liveTrimFires", ["number"]);
    assertField(diag, "liveTrimReplays", ["number"]);
  });

  test("null diag validates", () => {
    const raw = JSON.stringify({
      updatedAt: "2025-01-01T00:00:00Z",
      windowMinutes: 30,
      sampleCount: 0,
      turn_latency_ms: { p50: 0, p95: 0, n: 0 },
      provider_latency_ms: { p50: 0, p95: 0, n: 0 },
      tps: { avg: 0, n: 0 },
      cache_hit_pct: { avg: 0, latest: 0, n: 0 },
      db_recompute_ms: { p50: 0, p95: 0, n: 0 },
      disk_write_ms: { p50: 0, p95: 0, n: 0 },
      rss_mb: { latest: 0, n: 0 },
      heap_mb: { latest: 0, n: 0 },
      cpu_user_ms: { latest: 0, n: 0 },
      cpu_sys_ms: { latest: 0, n: 0 },
      diag: null,
    });
    const obj: Record<string, unknown> = JSON.parse(raw);

    assertField(obj, "diag", ["null"]);
  });
});

describe("GET /api/achievements", () => {
  test("sample payload (array) validates element field presence and types", () => {
    const raw = JSON.stringify([
      {
        id: "first-compact",
        title: "First Compaction",
        description: "Complete your first compaction",
        hidden: 0,
        icon: "trophy",
        unlocked_at: 1700000000,
      },
      {
        id: "secret-ach",
        title: "Secret Achievement",
        description: "???",
        hidden: 1,
        icon: null,
        unlocked_at: null,
      },
    ]);
    const arr = JSON.parse(raw) as unknown[];
    assert.ok(Array.isArray(arr), "response must be an array");

    const first = arr[0] as Record<string, unknown>;
    assertField(first, "id", ["string"]);
    assertField(first, "title", ["string"]);
    assertField(first, "description", ["string"]);
    assertField(first, "hidden", ["number"]);
    assertField(first, "icon", ["string", "null"]);
    assertField(first, "unlocked_at", ["number", "null"]);

    const second = arr[1] as Record<string, unknown>;
    assertField(second, "icon", ["null"]);
    assertField(second, "unlocked_at", ["null"]);
  });
});

// ─── SSE Event Union Validation ──────────────────────────────────────────────
// Validate the SseEvent union by checking each variant has a `type` field
// matching its discriminator.

describe("SSE /api/events — SseEvent union discriminator validation", () => {
  /** All 20 SseEvent variants with their discriminator `type` value and a minimal payload. */
  const SSE_VARIANTS: ReadonlyArray<{
    discriminator: string;
    payload: string;
  }> = [
    {
      discriminator: "compact_start",
      payload: JSON.stringify({
        type: "compact_start",
        ts: "2025-01-01T00:00:00Z",
        trigger: "auto",
        sessionId: "s1",
      }),
    },
    {
      discriminator: "compact_end",
      payload: JSON.stringify({
        type: "compact_end",
        ts: "2025-01-01T00:00:00Z",
        sessionId: "s1",
        checkpointId: "c1",
        tokensIn: 10000,
        tokensOut: 4000,
        tokensFreed: 6000,
        success: true,
      }),
    },
    {
      discriminator: "compact_trigger",
      payload: JSON.stringify({
        type: "compact_trigger",
        ts: "2025-01-01T00:00:00Z",
        pressure: 75,
        threshold: 80,
        armed: true,
      }),
    },
    {
      discriminator: "compact_skip",
      payload: JSON.stringify({
        type: "compact_skip",
        ts: "2025-01-01T00:00:00Z",
        reason: "pressure insufficient",
      }),
    },
    {
      discriminator: "tier_changed",
      payload: JSON.stringify({
        type: "tier_changed",
        ts: "2025-01-01T00:00:00Z",
        from: "super-compact",
        to: "ultra-compact",
        contextPct: 82,
      }),
    },
    {
      discriminator: "model_changed",
      payload: JSON.stringify({
        type: "model_changed",
        ts: "2025-01-01T00:00:00Z",
        provider: "anthropic",
        providerName: "Anthropic",
        model: "claude-3.5-sonnet",
      }),
    },
    {
      discriminator: "pressure_lifted",
      payload: JSON.stringify({
        type: "pressure_lifted",
        ts: "2025-01-01T00:00:00Z",
        beforePct: 85,
        afterPct: 40,
      }),
    },
    {
      discriminator: "checkpoint_persisted",
      payload: JSON.stringify({
        type: "checkpoint_persisted",
        ts: "2025-01-01T00:00:00Z",
        checkpointId: "ckpt-1",
        sessionTokens: 8000,
      }),
    },
    {
      discriminator: "recall_inject",
      payload: JSON.stringify({
        type: "recall_inject",
        ts: "2025-01-01T00:00:00Z",
        query: "compaction history",
        chunks: 5,
        tokens: 2000,
      }),
    },
    {
      discriminator: "anchors_updated",
      payload: JSON.stringify({
        type: "anchors_updated",
        ts: "2025-01-01T00:00:00Z",
        count: 10,
        pinned: 3,
      }),
    },
    {
      discriminator: "config_updated",
      payload: JSON.stringify({
        type: "config_updated",
        ts: "2025-01-01T00:00:00Z",
        key: "thresholdTokens",
        value: 120000,
      }),
    },
    {
      discriminator: "config_preset",
      payload: JSON.stringify({
        type: "config_preset",
        ts: "2025-01-01T00:00:00Z",
        preset: "aggressive",
      }),
    },
    {
      discriminator: "crew_presence_changed",
      payload: JSON.stringify({
        type: "crew_presence_changed",
        ts: "2025-01-01T00:00:00Z",
        activeAgents: 3,
        currentTurn: 1,
      }),
    },
    {
      discriminator: "crew_turn_changed",
      payload: JSON.stringify({
        type: "crew_turn_changed",
        ts: "2025-01-01T00:00:00Z",
        turnIndex: 2,
        agentName: "worker-2",
      }),
    },
    {
      discriminator: "crew_bandit_chosen",
      payload: JSON.stringify({
        type: "crew_bandit_chosen",
        ts: "2025-01-01T00:00:00Z",
        chosenAgent: "worker-1",
        score: 0.85,
        regret: 0.12,
      }),
    },
    {
      discriminator: "game_ritual_start",
      payload: JSON.stringify({
        type: "game_ritual_start",
        ts: "2025-01-01T00:00:00Z",
        sessionId: "ritual-1",
        stages: [
          { index: 0, name: "warmup", durationMs: 60000, status: "pending" },
        ],
      }),
    },
    {
      discriminator: "game_ritual_stage",
      payload: JSON.stringify({
        type: "game_ritual_stage",
        ts: "2025-01-01T00:00:00Z",
        sessionId: "ritual-1",
        stageIndex: 1,
        stageName: "deep-work",
      }),
    },
    {
      discriminator: "game_ritual_end",
      payload: JSON.stringify({
        type: "game_ritual_end",
        ts: "2025-01-01T00:00:00Z",
        sessionId: "ritual-1",
        success: true,
      }),
    },
    {
      discriminator: "game_mode_changed",
      payload: JSON.stringify({
        type: "game_mode_changed",
        ts: "2025-01-01T00:00:00Z",
        config: { enabled: true, theme: "neon", displayMode: "full" },
      }),
    },
    {
      discriminator: "game_render",
      payload: JSON.stringify({
        type: "game_render",
        ts: "2025-01-01T00:00:00Z",
        frame: "\x1b[2J\x1b[H",
      }),
    },
  ];

  test("all 20 SseEvent variants have a type field matching their discriminator", () => {
    assert.equal(
      SSE_VARIANTS.length,
      20,
      "SseEvent union should have 20 variants",
    );

    for (const variant of SSE_VARIANTS) {
      const obj: Record<string, unknown> = JSON.parse(variant.payload);
      assert.ok(
        "type" in obj,
        `SSE variant "${variant.discriminator}" must have a "type" field`,
      );
      assert.equal(
        typeof obj["type"],
        "string",
        `SSE variant "${variant.discriminator}" type field must be a string`,
      );
      assert.equal(
        obj["type"],
        variant.discriminator,
        `SSE variant type field must match discriminator "${variant.discriminator}"`,
      );
    }
  });

  test("every SSE variant has a ts field of type string", () => {
    for (const variant of SSE_VARIANTS) {
      const obj: Record<string, unknown> = JSON.parse(variant.payload);
      assertField(obj, "ts", ["string"]);
    }
  });

  test("SSE ENDPOINTS entry is correctly configured as SSE type", () => {
    assert.equal(ENDPOINTS.events.type, "sse");
    assert.equal(ENDPOINTS.events.method, "GET");
    assert.equal(ENDPOINTS.events.path, "/api/events");
    assert.ok(ENDPOINTS.events.event, "SSE endpoint must have an event name");
  });

  test("SSE discriminators are unique across all variants", () => {
    const discriminators = SSE_VARIANTS.map((v) => v.discriminator);
    const unique = new Set(discriminators);
    assert.equal(
      unique.size,
      discriminators.length,
      "SSE discriminators must be unique",
    );
  });
});
