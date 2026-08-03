# Implementation Readiness Checklist

A sprint cannot start until every applicable item is checked in its evidence record.

- [ ] predecessor evidence is reviewer-accepted; normative contracts and fixture IDs frozen
- [ ] exact production ownership, interfaces, algorithms/constants/ties, migrations, dashboard and config seams named
- [ ] each flag is positive `MEGACOMPACT_<NAME>`, default ON, `=0` off; root `src/config.ts` re-export and SETTINGS entry/exclusion named
- [ ] A/B/C have independent failure domains; C limitations are explicit
- [ ] exact test source and compiled paths exist in plan; fixture manifest inclusion defined; no zero-match globs
- [ ] annotation schema, samples/power, thresholds, rollout duration **and** events defined
- [ ] no-network runtime denial and TS/Rust dependency scans applicable
- [ ] downgrade/compatibility-journal disposition says migration ID or “pure—no migration”
- [ ] asset paths/digests/platform/offline clean-install/deploy gate applicable
- [ ] dashboard API contract/route registration/reader capability/client types/tab/tests/build applicable
- [ ] touched files remain below limits; touching over-limit `context-handler` first splits it
- [ ] rollback, breaker recovery, authority outage, spool, and clock chaos specified
- [ ] `npm run build && npm test && npm run lint`, regression, guardrails, docs consistency, link, schema, and `git diff --check` commands specified

Current backend facts always defer to root `CLAUDE.md` and inspected as-built source; stale `PLAN.md` statements (including better-sqlite) are not implementation authority. Baseline currently has two pre-existing hard file-size violations: do not worsen either, and split any one before touching it.
