# Evaluation and Rollout Contract

## Corpus and annotation

Corpus manifest records fixture/session IDs, source digest/license/consent, repository group, language, tool use, invalid UTF-8, duplicate occurrences, anchors, provider profile, and split. Train/calibration/test are grouped by repository+session; held-out test is immutable.

Annotation JSONL schema `conformance/vector-cortex/v2/schemas/annotation-v1.schema.json`:

```ts
interface AnnotationV1{itemId:string;annotatorId:string;head:"semantic"|"dependency"|"contradiction"|"cache"|"payload"|"reconstruction";leftSpan:string;rightSpan?:string;label:string;grade?:0|1|2|3;direction?:"left-to-right"|"right-to-left";evidenceSpans:string[];confidence:1|2|3;notes?:string}
```

Two independent annotators per item; blinded disagreement goes to a third adjudicator. Span match is exact event range for dependency/tool/payload, intersection-over-union ≥0.5 for semantic evidence, and exact canonical request digest for cache. Report raw agreement and Cohen’s kappa; κ<0.70 triggers guideline/corpus revision, not silent adjudication.

## Metrics and qualification

Minimum held-out: 2,000 pairs/head and ≥200 positives/head; reconstruction 1,000 sessions/10,000 turns including ≥200 tool sessions and 100 invalid/binary payloads. Semantic: Spearman ≥.75 and recall@10 ≥.90. Dependency: directed precision ≥.97, recall ≥.95. Contradiction: precision ≥.98, recall ≥.90, ECE ≤.05. Cache: precision ≥.999 (zero false-stable in poison corpus), recall ≥.90. Payload routing: macro-F1 ≥.97 and exact/anchor recall 1.0. Reconstruction: zero tool/causal/anchor/exact-byte violations; dependency closure recall 1.0; task-success A non-inferior to C.

Report Wilson intervals for proportions, stratified bootstrap (10,000, session-grouped) for continuous metrics, and per-head confusion/calibration. Powered non-inferiority is the preregistered one-sided 95% CI: `lower_bound(A-C) >= -0.01`. Power calculation (α=.05, power=.80, baseline and clustering assumption) determines required eligible sessions before rollout; the fixed minima above remain floors.

## Cache causality and rollout

Shadow cache hit/savings are estimates only and labeled `estimated_*`; they cannot establish causal savings. Causal cache savings require randomized, stable **session-level** assignment, live provider telemetry for billed input/cache-read tokens and cost, intent-to-treat analysis, and provider/profile stratification. No request-level crossover.

Each rollout level 1%, 5%, 25%, 50%, 100% requires **both** ≥72 hours and the powered sample target, plus ≥10,000 eligible events and ≥200 sessions. OR logic is forbidden. Stops: a causal, tool, anchor, exact-byte, network, cache-poison, or authority violation immediately returns C/manual halt; quality CI below margin, p95 latency >5% provider latency, or breaker C rate >0.5% pauses/demotes.

VC0A owns corpus/annotation schemas and evaluator skeleton; every sprint names affected strata and unique thresholds. VC5C owns randomized live reconstruction rollout; VC7B/C own cache telemetry experiment; VC8 canary uses the same AND gate. Evidence records sample/event/duration counts and CI inputs.
