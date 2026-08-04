// JSON Schema fixture envelopes (canonicalized by construction). Each domain
// module tags its fixtures with one of these via the `schema` field before the
// writer resolves the relative manifest path.

export const schemas = {};

schemas["schemas/eval-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "EVAL conformance fixture envelope",
  description: "Common structure every VC0A evaluation fixture validates against.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["metric", "annotation", "schema"] },
    expected: { type: "object" },
    input: { type: ["object", "array"] },
  },
};

schemas["schemas/metric-event-v1.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "MetricEventV1",
  description: "VC0A evaluation metric sample (contract types.ts).",
  type: "object",
  required: ["session", "seq", "event", "value", "unit", "mode"],
  properties: {
    session: { type: "string" },
    seq: { type: "integer" },
    event: { type: "string" },
    value: { type: "number" },
    unit: { type: "string", enum: ["ms", "bytes", "count", "ratio"] },
    mode: { type: "string", enum: ["A", "B", "C"] },
  },
};

schemas["schemas/annotation-v1.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "AnnotationV1",
  description: "VC0A redaction metadata (contract types.ts).",
  type: "object",
  required: ["itemId", "redactions", "redactedCount"],
  properties: {
    itemId: { type: "string" },
    redactions: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "digest", "bytes", "kind"],
        properties: {
          field: { type: "string" },
          digest: { type: "string" },
          bytes: { type: "integer" },
          kind: { type: "string", enum: ["payload", "prompt", "ledger"] },
        },
      },
    },
    redactedCount: { type: "integer" },
  },
};

schemas["schemas/replay-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "ReplayCutV2 conformance fixture envelope",
  description: "Common structure every VC0B replay/migration fixture validates against.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cut", "migration"] },
    expected: { type: "object" },
    input: { type: "object" },
  },
};

schemas["schemas/event-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "EventV2 fixture envelope",
  description:
    "Common structure every VC1A EventV2 codec (encode) / validator (validate) fixture validates against. Binary fields are unpadded-free standard base64.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["encode", "validate"] },
    expected: { type: "object" },
    input: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["sessionId", "seq", "eventId", "role", "kind", "bytesBase64"],
            properties: {
              sessionId: { type: "string" },
              seq: { type: "integer" },
              eventId: { type: "string" },
              role: { type: "string", enum: ["policy", "user", "assistant", "tool"] },
              kind: { type: "string" },
              bytesBase64: { type: "string" },
              toolCallId: { type: "string" },
              // Optional corruption overrides used by validate-kind rows: a
              // stored bytesDigest that does not match, and/or a stored utf8
              // discriminant that contradicts the actual bytes.
              bytesDigest: { type: "string" },
              utf8Tag: { type: "string", enum: ["valid", "invalid"] },
            },
          },
        },
      },
    },
  },
};

schemas["schemas/tri-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "TRI live-safety fixture envelope",
  description:
    "Common structure every VC0C resilience fixture validates against. kind=breaker fixtures pin the breaker transition the algorithm emits (window/probe/cooldown/backoff/hysteresis/manual-halt/reset); kind=spool fixtures pin the pure-spool verdict (append/fsync/ack/idempotent/gap/conflict/torn/restart/frozen-frontier). expected.code is the exact code/verdict the implementation must return.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["breaker", "spool", "schema"] },
    expected: {
      type: "object",
      properties: {
        code: { type: "string" },
        ok: { type: "boolean" },
        state: { type: "string" },
        committedSeq: { type: "integer" },
        reason: { type: "string" },
      },
    },
    input: { type: "object" },
  },
};

schemas["schemas/ledger-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "Occurrence-v2 ledger fixture envelope",
  description:
    "Common structure every VC1B occurrence-ledger / M2 downgrade fixture validates against. `input.occurrences` describes the v2 ledger to set up; `input.unrepresentable` names rows with no lossless legacy projection; `expected.ok`/`expected.code` gives the exact migration verdict.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["occurrence-v2", "migrate-down"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        count: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["occurrences"],
      properties: {
        scenario: { type: "string" },
        occurrences: {
          type: "array",
          items: {
            type: "object",
            required: ["seq", "eventId", "kind", "bytesBase64"],
            properties: {
              seq: { type: "integer" },
              eventId: { type: "string" },
              kind: { type: "string" },
              bytesBase64: { type: "string" },
              toolCallId: { type: "string" },
            },
          },
        },
        unrepresentable: { type: "array", items: { type: "string" } },
      },
    },
  },
};

schemas["schemas/minhash-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "MinHashV2 algorithm fixture envelope",
  description:
    "Common structure every VC1C MinHashV2 algorithm fixture validates against. `input` names the text/session; `expected.ok` success carries the published signature digest + 64 bucket bytes; failure rows carry an exact code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["minhash-v2"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        maxProduct: { type: "string" },
        signatureBytesHex: { type: "string" },
        signatureDigest: { type: "string" },
        buckets: { type: "array", items: { type: "string" } },
      },
    },
    input: { type: "object" },
  },
};

schemas["schemas/minhash-migration.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "M4 MinHashV2 migration fixture envelope",
  description:
    "Common structure every VC1C M4 minhash-v2 migration fixture validates against. `input.checkpoints` names the v1 index; `expected` gives the exact migration verdict (activeVersion, count, or failure code).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["minhash-v2"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        activeVersion: { type: "integer" },
        count: { type: "integer" },
        halted: { type: "boolean" },
        noDuplicates: { type: "boolean" },
        equalDigests: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "checkpoints"],
      properties: {
        scenario: { type: "string" },
        checkpoints: { type: "array", items: { type: "string" } },
        present: { type: "array", items: { type: "string" } },
        texts: { type: "array", items: { type: "string" } },
        activeStarting: { type: "integer" },
      },
    },
  },
};

schemas["schemas/conformance-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC1C conformance-manifest fixture envelope",
  description:
    "Common structure every VC1C conformance-manifest / downgrade fixture validates against. `input.scenario` names the temp-corpus mutation to run; `expected` gives the exact verdict/failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["conformance-v2"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        entryCount: { type: "integer" },
        deterministic: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      properties: {
        scenario: { type: "string" },
        domains: { type: "array", items: { type: "string" } },
        extraPath: { type: "string" },
        rows: { type: "integer" },
      },
    },
  },
};

schemas["schemas/minhash-seeds.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "MinHashV2 frozen seed table",
  description:
    "The published 256 unsigned (a,b) seed pairs + p for the frozen MinHashV2 scheme. Values exceed 2^53 so a/b/p are DECIMAL STRINGS for exactness.",
  type: "object",
  required: ["schema", "p", "count", "shingleCodePoints", "signatureBytes", "bands", "valuesPerBand", "seedPairs"],
  properties: {
    schema: { type: "string" },
    p: { type: "string" },
    count: { type: "integer" },
    shingleCodePoints: { type: "integer" },
    signatureBytes: { type: "integer" },
    bands: { type: "integer" },
    valuesPerBand: { type: "integer" },
    seedPairs: {
      type: "array",
      items: {
        type: "object",
        required: ["a", "b"],
        properties: { a: { type: "string" }, b: { type: "string" } },
      },
    },
  },
};

schemas["schemas/encoder-runtime-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC2A encoder-runtime fixture envelope",
  description:
    "Common structure every VC2A encoder-runtime fixture validates against. `input.scenario` names the asset/load condition the acceptance test executes against a TEMP asset dir; `expected` gives the exact verdict (ok/mode A) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["encoder-runtime"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        mode: { type: "string", enum: ["A", "B", "C"] },
        semanticWidth: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: { scenario: { type: "string" } },
    },
  },
};

schemas["schemas/encoder-heads-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC2B encoder-heads fixture envelope",
  description:
    "Common structure every VC2B encoder-heads fixture validates against. `input.scenario` names the head/fallback emission condition the acceptance test executes against the REAL heads/trigram/lexical producers; `expected` gives the exact verdict (ok) with shape facts (heads/dims/width/zero) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["encoder-heads"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        mode: { type: "string", enum: ["A", "B", "C"] },
        head: { type: "string" },
        dim: { type: "integer" },
        width: { type: "integer" },
        heads: { type: "integer" },
        zero: { type: "boolean" },
        dims: {
          type: "array",
          items: { type: "integer" },
        },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        head: { type: "string" },
      },
    },
  },
};

schemas["schemas/encoder-qualification-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC2C encoder-qualification fixture envelope",
  description:
    "Common structure every VC2C encoder-qualification fixture validates against. `input.scenario` names the calibration/qualification/fallback condition the acceptance test executes against the REAL calibrate/select/fallback producers; `expected` gives the exact verdict (ok/mode A) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["encoder-qualification"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        mode: { type: "string", enum: ["A", "B", "C"] },
        budgetBytes: { type: "integer" },
        splitDigest: { type: "string" },
        heads: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        head: { type: "string" },
        group: {
          type: "object",
          properties: { repository: { type: "string" }, session: { type: "string" } },
        },
      },
    },
  },
};

schemas["schemas/cortex-store-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC3A cortex-store fixture envelope",
  description:
    "Common structure every VC3A cortex-store fixture validates against. `input.scenario` names the capability/keying/rebuild condition the acceptance test executes against the REAL capability-gated cortex store; `expected` gives the exact verdict (ok) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cortex-store"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
      },
    },
  },
};

schemas["schemas/topology-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC3B topology fixture envelope",
  description:
    "Common structure every VC3B topology fixture validates against. `input.scenario` names the build condition the acceptance test executes against the REAL deterministic topology builder; `expected` gives the exact verdict (ok) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["topology"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
      },
    },
  },
};

schemas["schemas/topology-query-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC3C topology-query fixture envelope",
  description:
    "Common structure every VC3C topology-query fixture validates against. `input.scenario` names the key-encoding / unsigned-byte-order / no-prefix / invalidation / staleness / triad-demotion condition the acceptance test executes against the REAL query layer; `expected` gives the exact verdict (ok) or failure code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["topology-query"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        mode: { type: "string", enum: ["A", "B", "C"] },
        key: { type: "string" },
        noCollision: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        session: { type: "string" },
        generation: { type: "integer" },
        secondSession: { type: "string" },
        activeGeneration: { type: "integer" },
      },
    },
  },
};

schemas["schemas/router-generation-migration.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "M6 router-generation-v2 migration fixture envelope",
  description:
    "Common structure every VC3C M6 router-generation-v2 migration fixture validates against. `input` names the old per-session query set + migration scenario; `expected` gives the exact migration verdict (activeVersion, count, or failure code).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["router-generation-v2"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        activeVersion: { type: "integer" },
        count: { type: "integer" },
        halted: { type: "boolean" },
        noDuplicates: { type: "boolean" },
        noKeyCollision: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        sessions: { type: "array", items: { type: "string" } },
        activeStarting: { type: "integer" },
      },
    },
  },
};

schemas["schemas/shard-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC4A shard fixture envelope",
  description:
    "Common structure every VC4A shard fixture validates against. `input.scenario` names the semantic/exact partition or manifest-coverage condition the acceptance test executes against the REAL shard logic (partitionSemantic / partitionExact / validateShardManifest / assembleAndValidate); `expected` gives the exact verdict (ok) or failure code (SHD_CROSS_SESSION / SHD_INVALID_TARGET_SIZE / SHD_RANGE_OVERLAP / SHD_PROTECTED_GAP).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["shard"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        shardCount: { type: "integer" },
        eventCount: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        sessionId: { type: "string" },
        targetSize: { type: "integer" },
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["seq", "eventId", "role", "kind", "bytesBase64"],
            properties: {
              seq: { type: "integer" },
              eventId: { type: "string" },
              role: { type: "string", enum: ["policy", "user", "assistant", "tool"] },
              kind: { type: "string" },
              toolCallId: { type: "string" },
              bytesBase64: { type: "string" },
            },
          },
        },
        protected: {
          type: "array",
          items: {
            type: "object",
            required: ["case", "seqs"],
            properties: {
              case: { type: "string", enum: ["tool-pair", "anchor", "invalid-utf8", "anchor+invalid"] },
              seqs: { type: "array", items: { type: "integer" } },
            },
          },
        },
        manifest: {
          type: "object",
          properties: {
            semantic: { type: "array", items: { type: "object" } },
            exact: { type: "array", items: { type: "object" } },
            protectedSpans: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
};

schemas["schemas/residual-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC4B residual fixture envelope",
  description:
    "Common structure every VC4B residual fixture validates against. `input.scenario` names the DCT / quantization / parity / admission condition the acceptance test executes against the REAL residual codec (src/vector-cortex/residual/{dct,quantize,parity,codec}.js); `input.payload` describes the byte payload generatively (kind + length + seed) so a fixture never embeds a megabyte of base64; `expected` gives the exact verdict (ok) or the failure code (RES_QUANTIZE_RANGE / RES_TOO_MANY_ERASURES / RES_NOT_ADMITTED / RES_PAYLOAD_DIGEST_MISMATCH / RES_SHARD_DIGEST_MISMATCH / RES_DUPLICATE_SHARD_INDEX / RES_SHARD_LENGTH_MISMATCH / RES_HEADER_INVALID / RES_SINGULAR_MATRIX / RES_CORRECTION_DUPLICATE_OFFSET / RES_CORRECTION_RANGE).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["residual"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        admitted: { type: "boolean" },
        blockCount: { type: "integer" },
        exactRoundTrip: { type: "boolean" },
        minCorrections: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "payload"],
      properties: {
        scenario: { type: "string" },
        payload: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: ["empty", "zeros", "constant", "sequence", "lcg", "text", "invalid-utf8", "dc-outlier", "alternating", "literal"],
            },
            length: { type: "integer" },
            seed: { type: "integer" },
            value: { type: "integer" },
            outlierOffset: { type: "integer" },
            bytesBase64: { type: "string" },
          },
        },
        exactCompressedSize: { type: "integer" },
        admissionMode: { type: "string", enum: ["generous", "at-ceiling", "one-below-ceiling", "explicit"] },
        erasedIndices: { type: "array", items: { type: "integer" } },
        corruptIndices: { type: "array", items: { type: "integer" } },
        markErased: { type: "array", items: { type: "integer" } },
        mutate: {
          type: "string",
          enum: ["none", "duplicate-index", "truncate-shard", "corrupt-digest", "bad-magic", "corrupt-payload-digest"],
        },
      },
    },
  },
};

schemas["schemas/reconstruction-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC4C reconstruction fidelity fixture envelope",
  description:
    "Common structure every VC4C reconstruction fixture validates against. `input.scenario` names the closure / assembly / validation condition the acceptance test executes against the REAL reconstruct module (src/vector-cortex/reconstruct/{closure,assemble,validate}.js); `expected` gives the exact verdict (ok) or the failure code (REC_SOURCE_UNAVAILABLE / REC_ANCHOR_MISSING / REC_TOOL_PAIR_SPLIT / REC_DIGEST_MISMATCH / REC_CONTRADICTION_UNRESOLVED / REC_SPAN_OVERLAP). Graphs and shards are described declaratively by name and materialized by the test, so no byte payload is embedded.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["reconstruction"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "REC_SOURCE_UNAVAILABLE",
            "REC_ANCHOR_MISSING",
            "REC_TOOL_PAIR_SPLIT",
            "REC_DIGEST_MISMATCH",
            "REC_CONTRADICTION_UNRESOLVED",
            "REC_SPAN_OVERLAP",
            "CLO_CONTRADICTION_UNRESOLVED",
            "CLO_UNKNOWN_SEED",
            "CLO_MISSING_NODE",
          ],
        },
        selected: { type: "array", items: { type: "string" } },
        selectedCount: { type: "integer" },
        unresolved: { type: "array", items: { type: "string" } },
        removedContradictions: { type: "array", items: { type: "string" } },
        spanCount: { type: "integer" },
        protectedSpanCount: { type: "integer" },
        byteTotal: { type: "integer" },
        mandatoryTokenEstimate: { type: "integer" },
        closureReachedFixedPoint: { type: "boolean" },
        assemblySortedBySource: { type: "boolean" },
        digestIsConcatenation: { type: "boolean" },
        summaryOpaque: { type: "boolean" },
        semanticExcluded: { type: "boolean" },
        semanticLossStated: { type: "boolean" },
        bySource: {
          type: "object",
          properties: {
            exact: { type: "integer" },
            residual: { type: "integer" },
            semantic: { type: "integer" },
          },
        },
        emits: {
          type: "string",
          enum: ["vector_cortex_reconstruction_validated", "vector_cortex_closure_rejected"],
        },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        graph: { type: "string" },
        shards: { type: "string" },
        seeds: { type: "array", items: { type: "string" } },
        eraseShard: { type: "string" },
        closureOk: { type: "boolean" },
        mode: { type: "string", enum: ["A", "B", "C"] },
        forceModeB: { type: "boolean" },
      },
    },
  },
};

schemas["schemas/prompt-dag-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC5A PromptDagV1 fixture envelope",
  description:
    "Common structure every VC5A prompt-dag fixture validates against. `input.scenario` names the build/validate condition the acceptance test executes against the REAL prompt-dag module (src/vector-cortex/prompt-dag/{builder,validator}.js); `input.graph` names a declaratively-described DAG the test materializes (no byte payload embedded). `expected.ok` pins a clean build/validate (optionally the exact topological `order`); failure rows pin an exact `code` (DAG_MIXED_SESSION / DAG_DUPLICATE_ID / DAG_MISSING_ENDPOINT / DAG_INVALID_SPAN / DAG_SPAN_DIGEST_CONFLICT / DAG_REVERSED_PRECEDES / DAG_CYCLE / DAG_TOOL_PAIR_SPLIT / DAG_UNKNOWN_INCOMPATIBLE).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["prompt-dag"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        codes: { type: "array", items: { type: "string" } },
        order: { type: "array", items: { type: "string" } },
        orderLength: { type: "integer" },
        stableKahn: { type: "boolean" },
        permutationInvariant: { type: "boolean" },
        digestStable: { type: "boolean" },
        digestSensitive: { type: "boolean" },
        totalOrder: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string" },
        graph: { type: "string" },
        permute: { type: "boolean" },
        mutateDigest: { type: "boolean" },
      },
    },
  },
};

schemas["schemas/planner-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC5A PlanV1 fixture envelope",
  description:
    "Common structure every VC5A planner fixture validates against. `input.scenario` names the budget-admission / selection / closure condition the acceptance test executes against the REAL planner module (src/vector-cortex/planner/{portfolio,manifest}.js); `input.candidates` names a candidate set the test materializes together with `tokenBudget`. `expected.ok` pins the accepted plan (optionally the exact `selected` ids, `tokenTotal`, or tie-break verdicts) or an exact failure `code` (MANDATORY_CLOSURE_OVER_BUDGET / PLN_INVALID_BUDGET / PLN_MANIFEST_DIGEST_MISMATCH).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["planner"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "MANDATORY_CLOSURE_OVER_BUDGET",
            "PLN_UNKNOWN_NODE",
            "PLN_INCOMPATIBLE_SELECTION",
            "PLN_MANIFEST_DIGEST_MISMATCH",
            "PLN_INVALID_BUDGET",
          ],
        },
        selected: { type: "array", items: { type: "string" } },
        tokenTotal: { type: "integer" },
        firstSelected: { type: "string" },
        mandatoryPreserved: { type: "boolean" },
        demotesToC: { type: "boolean" },
        omittedOverBudget: { type: "boolean" },
        omittedZeroUtility: { type: "boolean" },
        omittedIncompatible: { type: "boolean" },
        noPartialSelection: { type: "boolean" },
        withinBudget: { type: "boolean" },
        planIsClosed: { type: "boolean" },
        permutationInvariant: { type: "boolean" },
        manifestStable: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "candidates", "tokenBudget"],
      properties: {
        scenario: { type: "string" },
        candidates: { type: "string" },
        tokenBudget: { type: "integer" },
        zeroFraming: { type: "boolean" },
        permute: { type: "boolean" },
        mutateTokensAfterPlan: { type: "boolean" },
      },
    },
  },
};

schemas["schemas/render-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC5B render fixture envelope",
  description:
    "Common structure every VC5B render fixture validates against. `input.scenario` names the render/validate condition the acceptance test executes against the REAL render module (src/vector-cortex/render/{renderer,validator}.js); `input.graph` names a declaratively-described DAG the test materializes (no byte payload embedded); `input.profile` names the (provider, model) looked up in the registry. `expected.ok` pins a clean render (optionally the exact `nodeOrder`, `requestDigestStable`, `toolBytesExact`, `bypassClean`) or an exact failure `code` (REN_ORDER_MISMATCH / REN_TOOL_BYTE_MISMATCH / REN_BYTE_LENGTH_MISMATCH / REN_PROVIDER_CONSTRAINT_VIOLATED / REN_PROFILE_DIGEST_MISMATCH / REN_PROFILE_UNKNOWN).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["render"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "REN_ORDER_MISMATCH",
            "REN_TOOL_BYTE_MISMATCH",
            "REN_BYTE_LENGTH_MISMATCH",
            "REN_PROVIDER_CONSTRAINT_VIOLATED",
            "REN_PROFILE_DIGEST_MISMATCH",
            "REN_PROFILE_UNKNOWN",
          ],
        },
        nodeOrder: { type: "array", items: { type: "string" } },
        orderReplay: { type: "boolean" },
        permutationInvariant: { type: "boolean" },
        toolBytesExact: { type: "boolean" },
        invalidUtf8Survives: { type: "boolean" },
        requestDigestStable: { type: "boolean" },
        requestDigestSensitive: { type: "boolean" },
        digestOrderIndependent: { type: "boolean" },
        hashModeEntire: { type: "boolean" },
        bypassClean: { type: "boolean" },
        profileResolved: { type: "boolean" },
        selectsTriadC: { type: "boolean" },
        usesHostPrependSeam: { type: "boolean" },
        forbidsSystemRole: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "graph", "profile"],
      properties: {
        scenario: { type: "string" },
        graph: { type: "string" },
        profile: { type: "string" },
        mutateByteAfterRender: { type: "boolean" },
        swapProfileAfterRender: { type: "boolean" },
      },
    },
  },
};

schemas["schemas/provider-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC5B provider fixture envelope",
  description:
    "Common structure every VC5B provider fixture validates against. `input.scenario` names the resolution / cache-identity condition the acceptance test executes against the REAL provider registry (src/vector-cortex/provider/registry.js); `input.provider`/`input.model` name the exact-match lookup key. `expected.ok` pins a clean resolution (optionally the exact `profileId` / `hashMode` / `excludedPointers`) or an exact bypass `code` (PRO_PROFILE_UNKNOWN / PRO_PROFILE_VERSION_UNSUPPORTED).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["provider"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: ["PRO_PROFILE_UNKNOWN", "PRO_PROFILE_VERSION_UNSUPPORTED"],
        },
        profileId: { type: "string" },
        hashMode: { type: "string", enum: ["entire-canonical-request"] },
        excludedPointers: { type: "array", items: { type: "string" } },
        bypassClean: { type: "boolean" },
        cacheStable: { type: "boolean" },
        deterministic: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "provider", "model"],
      properties: {
        scenario: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
    },
  },
};

schemas["schemas/rollout-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC5C rollout fixture envelope",
  description:
    "Common structure every VC5C rollout fixture validates against. `input.scenario` names the assignment/gate condition the acceptance test executes against the REAL rollout module (src/vector-cortex/rollout/{assign,gate}.js): `assign-stable` (deterministic bucket for a fixed session digest), `gate-power` (72h residency + powered sample + >=10k events + >=200 sessions advances ONE gate, else blocked), `gate-safety` (a single hard causal/tool/anchor/exact fault freezes promotion and selects pre-VC path). `input.sessionId` names the session the test assigns; `input.evidence` carries the window evidence. `expected.ok` pins a clean assignment/advance (optionally the exact `bucket`, `gateIndex`, `promotionBlocked`, `selectsPreVc`) or a precise blocked outcome.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["rollout"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        bucket: { type: "integer", minimum: 0, maximum: 9999 },
        gateIndex: { type: "integer", minimum: 0, maximum: 4 },
        promotionBlocked: { type: "boolean" },
        selectsPreVc: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario"],
      properties: {
        scenario: { type: "string", enum: ["assign-stable", "gate-power", "gate-safety"] },
        sessionId: { type: "string" },
        evidence: {
          type: "object",
          properties: {
            windowStartMs: { type: "integer" },
            powered: { type: "boolean" },
            events: { type: "integer" },
            sessions: { type: "integer" },
            hardFaults: {
              type: "array",
              items: {
                type: "object",
                required: ["kind", "detail"],
                properties: {
                  kind: { type: "string", enum: ["causal", "tool", "anchor", "exact"] },
                  detail: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};
