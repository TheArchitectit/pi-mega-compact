/**
 * endpoints-registry.test.ts — ENDPOINTS registry contract validation.
 *
 * Split out of api-contracts.test.ts. Two layers:
 * 1. COMPILE-TIME: `satisfies` checks for each endpoint in the ENDPOINTS registry,
 *    ensuring response types are structurally compatible with their interfaces.
 * 2. RUNTIME: verifies the count, path/method/description invariants of the
 *    registry, and that every `/api/*` endpoint in `server.ts` has a
 *    corresponding entry.
 *
 * PREVENT-PI-004: zero network calls.
 * PREVENT-011: no `any` type — `unknown` + runtime guards used throughout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS } from "../api-contracts/index.js";
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
	PerfSamplesQuery,
	PerfSamplesResponse,
	AchievementRow,
	SseEvent,
} from "../api-contracts/index.js";

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
const _c_perfSamples = ENDPOINTS.perfSamples satisfies EndpointDef<
	"GET",
	PerfSamplesQuery,
	PerfSamplesResponse
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
void _c_perfSamples;
void _c_achievements;

// ─── Compile-Time: ENDPOINTS path/method consistency ─────────────────────────
// Verify the ENDPOINTS registry has exactly the expected number of entries with
// correct paths.

const ENDPOINT_KEYS = Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[];
const EXPECTED_ENDPOINT_COUNT = 49; // 47 + vector-cortex evaluation (VC0A) + ledger (VC1B)

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
	"/api/perf/samples",
	"/api/achievements",
	"/api/sessions",
	"/api/sessions/timeseries",
	"/api/topics",
	"/api/provider-cache",
	"/api/rag-settings",
	"/api/raptor-build-history",
	"/api/vector-cortex/evaluation",
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ENDPOINTS registry", () => {
	test("has exactly the expected endpoint count", () => {
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
