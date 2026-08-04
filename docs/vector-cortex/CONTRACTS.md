# Vector Cortex Normative Contracts

**Status:** implementation contract. Conformance root: `conformance/vector-cortex/v2/`.

## EventV2: byte authority

```ts
interface EventV2 {
  schema: "event-v2"; sessionId: string; seq: bigint; eventId: string;
  role: "policy"|"user"|"assistant"|"tool"; kind: string;
  originalBytes: Uint8Array; bytesDigest: `sha256:${string}`;
  utf8: { valid: true; text: string } | { valid: false; base64: string };
  canonicalNfc?: string; toolCallId?: string; occurredAtMs: bigint;
}
```

`policy` represents host/provider policy input in the neutral ledger; the pi adapter keeps it in the sanctioned prompt-policy channel and MUST NOT create a conversation message for it. `originalBytes` and its SHA-256 digest are authoritative. UTF-8 is decoded strictly; invalid input is represented only as `{valid:false,base64}` and is never replaced. `canonicalNfc` is a derived comparison/search key for valid UTF-8, never storage, rendering, hashing, or equality authority. Ordering is `(sessionId,seq,eventId bytewise UTF-8)`; equal content remains separate occurrences. A tool result references exactly one earlier call in the same session.

## PromptDagV1 (owned by VC5A)

Schema: `conformance/vector-cortex/v2/schemas/prompt-dag-v1.schema.json`; TS contract/builder/validator: `src/vector-cortex/prompt-dag/{types,builder,validator}.ts`; fixtures: `conformance/vector-cortex/v2/prompt-dag/`; tests: `src/vector-cortex/prompt-dag/{builder,validator}.test.ts`.

```ts
type Span={sessionId:string;startSeq:bigint;endSeq:bigint;startByte:number;endByte:number;digest:`sha256:${string}`};
type DagNode={id:string;kind:"event"|"exact"|"semantic"|"synthetic";span?:Span;syntheticOrdinal?:number;payloadDigest:string;incompatibleWith:readonly string[]};
type DagEdge={from:string;to:string;kind:"precedes"|"depends"|"tool-pair"|"contradicts"};
interface PromptDagV1{schema:"prompt-dag-v1";sessionId:string;sourceHighWater:bigint;nodes:readonly DagNode[];edges:readonly DagEdge[]}
interface PromptDagBuilder{build(sessionId:string,events:readonly EventV2[],derived:readonly DagNode[]):PromptDagV1}
interface PromptDagValidator{validate(dag:PromptDagV1):{ok:true;order:readonly string[]}|{ok:false;codes:readonly string[]}}
```

A PromptDagV1 is single-session: every event/span MUST equal `dag.sessionId`; cross-session evidence is represented by a synthetic node whose payload cites a separately validated source manifest. Edges point prerequisite/earlier **from → dependent/later to**. Event nodes order by source span; ranges are inclusive event seq and half-open byte offsets. Synthetic nodes have no span and order after the latest prerequisite, then `syntheticOrdinal`, then node ID bytes. Topological sort is stable Kahn: zero-indegree queue by `(span.startSeq or MAX, syntheticOrdinal or 0,id bytes)`. Reject mixed-session nodes, duplicate IDs, missing endpoints, invalid/overlapping spans with mismatched digest, reversed `precedes`, cycles, split tool pairs, selected incompatible pairs, or unresolved contradiction. Never use object/map iteration as order.

## Plan and closure

```ts
interface PlanV1{schema:"plan-v1";dagDigest:string;selectedNodeIds:readonly string[];tokenBudget:number;dependencyHighWater:bigint;omissions:readonly {nodeId:string;reason:string}[]}
interface ClosureResult{ok:boolean;selected:readonly string[];addedDependencies:readonly string[];removedContradictions:readonly string[];unresolved:readonly string[]}
```

VC4C owns mandatory conservative closure before VC5: recursively add all `depends`/tool-pair predecessors; for contradictions keep the later exact source unless an explicit resolution event names the loser; ties keep both and reject live use. Preserve anchor floor and return the closed mandatory node set plus its deterministic token estimate. VC5A exclusively owns framing/budget admission: it adds framing cost to the VC4C estimate and, if mandatory cost exceeds `tokenBudget`, returns `MANDATORY_CLOSURE_OVER_BUDGET` without truncating mandatory nodes. The live adapter demotes to C, whose existing pair-safe emergency cap/overflow behavior remains authoritative. VC6 only optimizes restoration/self-healing.

## ProviderProfileV1 and crystals

VC5B owns `src/vector-cortex/provider/{types,registry}.ts` and the base fixture-backed registry. Entire canonical outbound request bytes are SHA-256 hashed by default. A profile may exclude a field only when a fixture proves it cannot affect provider cache identity; exclusions are versioned and listed in the manifest. Unknown provider/profile/version bypasses crystals.

```ts
interface ProviderProfileV1{schema:"provider-profile-v1";id:string;version:string;hashMode:"entire-canonical-request";excludedJsonPointers:readonly {pointer:string;fixtureId:string;proofDigest:string}[]}
interface CrystalKeyV1{profileId:string;profileVersion:string;requestDigest:string;sourceRanges:readonly Span[];coveredDigest:string;dependencyHighWater:bigint;rendererVersion:string}
```

A crystal is keyed by its covered source ranges/digest and validated dependency high-water—not the changing global ledger frontier. Any covered-byte, dependency, profile, or renderer change invalidates it.

## TriadResult and breaker seam

```ts
type Mode="A"|"B"|"C";
type TriadResult<T>={ok:true;value:T;mode:Mode;inputDigest:string;outputDigest:string;algorithmVersion:string;latencyMs:number;breaker:BreakerRecord}|{ok:false;mode:Mode;code:string;retryable:boolean;breaker:BreakerRecord};
interface Breaker{execute<T>(subsystem:string,inputDigest:string,run:Record<Mode,()=>T>,validate:(v:T)=>boolean):TriadResult<T>;recordProbe(...args:readonly unknown[]):BreakerRecord;manualHalt(reason:string):BreakerRecord}
```

See [TRIAD_RESILIENCE](TRIAD_RESILIENCE.md) for state constants, spool, independence, and clock rules.

## Store and migration contracts

Ledger exposes `asReader`, append-only `asWriter`, and maintenance `asAdmin`; dashboard receives reader only. Derived frontier cannot exceed the contiguous durable authority high-water and cannot advance during authority/spool outage.

Downgrade strategy is a **compatibility journal**, not stale legacy state. From v2 activation every accepted v2 append atomically appends `compat-journal-v1` containing original bytes, IDs, and a legacy projection or explicit `unrepresentable` marker. `scripts/vector-cortex-downgrade-export.mjs` verifies sequence/digests then writes a new legacy store; it never mutates v2. An old binary may open only the exported copy. VC1B owns journal/write integration and `old-binary-after-new-writes` test; VC1C owns exporter/conformance. Silent direct downgrade is rejected.
