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

schemas["schemas/closure-optimization-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC6A closure-optimization fixture envelope",
  description:
    "Common structure every VC6A closure-optimization fixture validates against. `input.graph` is a FULL ClosureGraph fed verbatim into `closeSelection` then `optimizeClosure` then `verifyProof`; `input.seeds` are the closure seeds; `input.scenario` names the optimizer/verifier condition the acceptance test executes against the REAL heal module (src/vector-cortex/heal/{closure-opt,proof}.js), no mocks. `expected` pins the verifier verdict (`ok`) or the exact HEAL_* failure code plus the optimizer's edge accounting (removedEdges / retainedEdges / protectedRetained) and the invariant that the optimized selected set equals the conservative oracle (selectedMatch).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["closure-optimization"] },
    expected: {
      type: "object",
      required: ["ok", "removedEdges", "retainedEdges", "selectedMatch", "protectedRetained"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "HEAL_PROOF_SET_MISMATCH",
            "HEAL_PROOF_INCOMPLETE",
            "HEAL_PROOF_PROTECTED_REMOVED",
            "HEAL_PROOF_WITNESS_INVALID",
            "HEAL_CLOSURE_REJECTED",
          ],
        },
        removedEdges: { type: "integer", minimum: 0 },
        retainedEdges: { type: "integer", minimum: 0 },
        selectedMatch: { type: "boolean" },
        protectedRetained: { type: "integer", minimum: 0 },
        deterministic: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["graph", "scenario", "seeds"],
      properties: {
        graph: {
          type: "object",
          required: ["sessionId", "nodes", "edges"],
          properties: {
            sessionId: { type: "string" },
            nodes: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "kind", "tokenEstimate"],
                properties: {
                  id: { type: "string" },
                  kind: { type: "string" },
                  tokenEstimate: { type: "integer" },
                  anchor: { type: "boolean" },
                },
              },
            },
            edges: {
              type: "array",
              items: {
                type: "object",
                required: ["from", "to", "kind"],
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                  kind: { type: "string", enum: ["depends", "tool-pair", "contradicts"] },
                },
              },
            },
            resolutions: {
              type: "array",
              items: {
                type: "object",
                required: ["loserId", "winnerId"],
                properties: {
                  loserId: { type: "string" },
                  winnerId: { type: "string" },
                },
              },
            },
          },
        },
        scenario: { type: "string" },
        seeds: { type: "array", items: { type: "string" } },
      },
    },
  },
};

schemas["schemas/restoration-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC6B restoration fixture envelope",
  description:
    "Common structure every VC6B restoration fixture validates against. `input.request` is a full RestoreRequestV1 (span identity by ShardRange plus the pinned SHA-256 span digest in BARE lowercase hex, no `sha256:` prefix); `input.exactShards` and `input.ledgerEvents` are the ONLY sources the restorer may read, decoded by the acceptance test into real ExactShardV1 / EventV2 objects (bytes are base64, `seq` is a JSON number converted to BigInt) and fed verbatim into the REAL heal modules (src/vector-cortex/heal/{restore,verify}.js), no mocks. `input.scenario` names the restoration condition. `expected` pins the restore verdict: `ok` (restored AND verified) or the exact HEAL_RESTORE_* failure code, plus the span accounting (restoredCount / missingCount) and the triad `mode` (A = indexed exact shards, B = ledger range scan, C = a span no exact source covers, omitted with the semantic loss disclosed).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["restoration"] },
    expected: {
      type: "object",
      required: ["ok", "restoredCount", "missingCount", "mode"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "HEAL_RESTORE_LIMIT",
            "HEAL_RESTORE_DIGEST_MISMATCH",
            "HEAL_RESTORE_SOURCE_MISSING",
            "HEAL_RESTORE_RANGE_MISMATCH",
          ],
        },
        restoredCount: { type: "integer", minimum: 0 },
        missingCount: { type: "integer", minimum: 0 },
        mode: { type: "string", enum: ["A", "B", "C"] },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "sessionId", "request", "exactShards", "ledgerEvents"],
      properties: {
        scenario: { type: "string" },
        sessionId: { type: "string" },
        request: {
          type: "object",
          required: ["spans"],
          properties: {
            spans: {
              type: "array",
              items: {
                type: "object",
                required: ["nodeId", "range", "digest"],
                properties: {
                  nodeId: { type: "string" },
                  range: { $ref: "#/definitions/shardRange" },
                  digest: { type: "string" },
                },
              },
            },
          },
        },
        exactShards: {
          type: "array",
          items: {
            type: "object",
            required: ["sessionId", "range", "originalBytesBase64", "digest", "byteCount", "case"],
            properties: {
              sessionId: { type: "string" },
              range: { $ref: "#/definitions/shardRange" },
              originalBytesBase64: { type: "string" },
              digest: { type: "string" },
              byteCount: { type: "integer", minimum: 0 },
              case: {
                type: "string",
                enum: ["tool-pair", "anchor", "invalid-utf8", "anchor+invalid"],
              },
            },
          },
        },
        ledgerEvents: {
          type: "array",
          items: {
            type: "object",
            required: [
              "sessionId",
              "seq",
              "eventId",
              "role",
              "kind",
              "originalBytesBase64",
              "bytesDigest",
              "occurredAtMs",
            ],
            properties: {
              sessionId: { type: "string" },
              seq: { type: "integer", minimum: 0 },
              eventId: { type: "string" },
              role: { type: "string", enum: ["policy", "user", "assistant", "tool"] },
              kind: { type: "string" },
              originalBytesBase64: { type: "string" },
              bytesDigest: { type: "string" },
              occurredAtMs: { type: "integer", minimum: 0 },
              toolCallId: { type: "string" },
            },
          },
        },
      },
    },
  },
  definitions: {
    shardRange: {
      type: "object",
      required: ["sessionId", "seqStart", "seqEnd", "byteStart", "byteEnd"],
      properties: {
        sessionId: { type: "string" },
        seqStart: { type: "integer", minimum: 0 },
        seqEnd: { type: "integer", minimum: 0 },
        byteStart: { type: "integer", minimum: 0 },
        byteEnd: { type: "integer", minimum: 0 },
      },
    },
  },
};

schemas["schemas/healing-controller-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC6C healing-controller fixture envelope",
  description:
    "Common structure every VC6C healing-controller fixture validates against. `input.states` is the controller's read-only view of each derived subsystem (derived high-water vs the DURABLE AUTHORITY high-water, which the controller reads and never writes), and `input.nowMs` is an INJECTED monotonic clock — VC6C takes the clock as an argument precisely so rate-limit and backoff rows are reproducible. `input.mode` dispatches the acceptance test to the real entry point: `detect` drives detectGaps(states, nowMs), `backoff` drives computeBackoff(subsystem, attempt), `rebuild` drives rebuildGeneration + switchPointer over `input.rebuild` (base64 source bytes plus the pinned BARE lowercase hex root digest). All rows are fed verbatim into the REAL heal modules (src/vector-cortex/heal/{controller,rebuild}.js), no mocks. `expected` pins the repair verdict: `ok` or the exact HEAL_REPAIR_* / HEAL_REBUILD_* code, the number of plans produced (`plannedCount`), the exact [seqStart, seqEnd] window of each plan in plan order (`ranges`, so a controller that plans the WRONG window fails even when the count is right), and for rebuild rows whether the pointer moved (`switched`) and the live generation afterwards (`generation`).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["healing-controller"] },
    expected: {
      type: "object",
      required: ["ok", "plannedCount", "ranges"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "HEAL_REPAIR_AUTHORITY_FROZEN",
            "HEAL_REPAIR_DIGEST_MISMATCH",
            "HEAL_REBUILD_FAILED",
            "HEAL_REPAIR_RATE_LIMITED",
          ],
        },
        plannedCount: { type: "integer", minimum: 0 },
        ranges: {
          type: "array",
          items: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            minItems: 2,
            maxItems: 2,
          },
        },
        switched: { type: "boolean" },
        generation: { type: "integer", minimum: 0 },
        semanticLossStated: { type: "boolean" },
        monotonic: { type: "boolean" },
        capped: { type: "boolean" },
        idempotent: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "mode", "nowMs", "states"],
      properties: {
        scenario: { type: "string" },
        mode: { type: "string", enum: ["detect", "backoff", "rebuild"] },
        nowMs: { type: "integer", minimum: 0 },
        states: {
          type: "array",
          items: {
            type: "object",
            required: [
              "subsystem",
              "derivedHighWater",
              "authorityHighWater",
              "lastRebuildAt",
              "generation",
              "mode",
            ],
            properties: {
              subsystem: { type: "string" },
              derivedHighWater: { type: "integer", minimum: 0 },
              authorityHighWater: { type: "integer", minimum: 0 },
              lastRebuildAt: { type: ["integer", "null"], minimum: 0 },
              generation: { type: "integer", minimum: 0 },
              mode: { type: "string", enum: ["A", "B", "C"] },
              failedAttempts: { type: "integer", minimum: 0 },
              authorityFrozen: { type: "boolean" },
            },
          },
        },
        rebuild: {
          type: "object",
          required: [
            "subsystem",
            "generation",
            "currentGeneration",
            "sourceBytesBase64",
            "expectedDigest",
            "triadMode",
          ],
          properties: {
            subsystem: { type: "string" },
            generation: { type: "integer", minimum: 0 },
            currentGeneration: { type: "integer", minimum: 0 },
            sourceBytesBase64: { type: "string" },
            expectedDigest: { type: "string" },
            triadMode: { type: "string", enum: ["A", "B", "C"] },
          },
        },
        backoff: {
          type: "object",
          required: ["subsystem", "attempts"],
          properties: {
            subsystem: { type: "string" },
            attempts: { type: "array", items: { type: "integer", minimum: 0 } },
          },
        },
      },
    },
  },
};

// VC7A: the covered-range and crystal-key shapes appear at three sites in the
// cache-crystal envelope. Emitted from helpers (not $ref) so every site carries
// the full inline schema the conformance validator actually enforces.
function crystalSpanSchema() {
  return {
    type: "object",
    required: ["sessionId", "startSeq", "endSeq", "startByte", "endByte", "digest"],
    properties: {
      sessionId: { type: "string" },
      startSeq: { type: "integer", minimum: 0 },
      endSeq: { type: "integer", minimum: 0 },
      startByte: { type: "integer" },
      endByte: { type: "integer" },
      digest: { type: "string" },
    },
  };
}

function crystalKeySchema() {
  return {
    type: "object",
    required: [
      "profileId",
      "profileVersion",
      "requestDigest",
      "rendererVersion",
      "dependencyHighWater",
      "sourceRanges",
    ],
    properties: {
      profileId: { type: "string" },
      profileVersion: { type: "string" },
      requestDigest: { type: "string" },
      rendererVersion: { type: "string" },
      dependencyHighWater: { type: "integer", minimum: 0 },
      sourceRanges: { type: "array", items: crystalSpanSchema() },
    },
  };
}

schemas["schemas/cache-crystal-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC7A cache-crystal fixture envelope",
  description:
    "Common structure every VC7A frozen-range-crystal fixture validates against. `input.key` (and, for comparison rows, `input.other`) is a CrystalKeyV1 identity: the provider profile + version, the BARE lowercase hex canonical request digest, the renderer version, the VALIDATED durable dependency high-water (a JSON number the loader converts to BigInt), and the covered `sourceRanges`, each a DagSpan whose `digest` is `sha256:` prefixed over that range's covered content. THE GLOBAL LEDGER FRONTIER IS DELIBERATELY ABSENT from this schema: it is not part of crystal identity, so it is not representable here - CRY-FRONTIER-001 expresses an unrelated append via the informational `input.unrelatedAppend` range, which the key does not cover and which must therefore leave the key byte-identical. `input.scenario` dispatches the acceptance test to the real entry point: `key` drives encodeCrystalKey(key) asserting ok/code (plus canonical sort order for ordering rows), `compare` drives encodeCrystalKey on BOTH identities asserting `expected.sameKey` (true = the mutation was not an identity field; false = it was and invalidated the key), and `store` drives CrystalStore freeze/write over `input.bytes` (and `input.secondBytes` for idempotence/collision rows). All rows are fed verbatim into the REAL cache modules (src/vector-cortex/cache/{crystal,store}.js), no mocks. Every digest in the corpus is a real SHA-256 over the row's own content, never hand-written. The span and key shapes are inlined rather than $ref'd because the conformance validator implements the schema subset our corpus uses; a $ref node would type-check as nothing and validate silently.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cache-crystal"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "CRY_RANGE_OVERLAP",
            "CRY_KEY_COLLISION",
            "CRY_RANGE_INVALID",
            "CRY_RANGE_EMPTY",
            "CRY_KEY_LIMIT",
            "CRY_STORE_UNAVAILABLE",
          ],
        },
        sameKey: { type: "boolean" },
        written: { type: "boolean" },
        crystalCount: { type: "integer", minimum: 0 },
        rangeCount: { type: "integer", minimum: 0 },
        sortedSessions: { type: "array", items: { type: "string" } },
        sortedStartBytes: { type: "array", items: { type: "integer", minimum: 0 } },
        mode: { type: "string", enum: ["A", "B", "C"] },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "mode", "key"],
      properties: {
        scenario: { type: "string", enum: ["key", "compare", "store"] },
        mode: { type: "string" },
        bytes: { type: "string" },
        secondBytes: { type: "string" },
        key: crystalKeySchema(),
        other: crystalKeySchema(),
        unrelatedAppend: crystalSpanSchema(),
      },
    },
  },
};

// VC7B: the covered-range and economics shapes appear at several sites in the
// cache-economics envelope. Emitted from helpers (not $ref) so every site carries
// the full inline schema the conformance validator actually enforces.
function econSpanSchema() {
  return {
    type: "object",
    required: ["sessionId", "startSeq", "endSeq", "startByte", "endByte", "digest"],
    properties: {
      sessionId: { type: "string" },
      startSeq: { type: "integer", minimum: 0 },
      endSeq: { type: "integer", minimum: 0 },
      startByte: { type: "integer" },
      endByte: { type: "integer" },
      digest: { type: "string" },
    },
  };
}

function econProfileSchema() {
  return {
    type: "object",
    required: [
      "schema",
      "profileId",
      "profileVersion",
      "basePrice",
      "readPrice",
      "writePrice",
      "ttlMs",
      "minPrefix",
    ],
    properties: {
      schema: { type: "string", enum: ["provider-economics-v1"] },
      profileId: { type: "string" },
      profileVersion: { type: "string" },
      basePrice: { type: "number" },
      readPrice: { type: "number" },
      writePrice: { type: "number" },
      ttlMs: { type: "integer" },
      minPrefix: { type: "integer" },
      exclusionFixtureId: { type: ["string", "null"] },
    },
  };
}

schemas["schemas/cache-economics-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC7B cache-economics fixture envelope",
  description:
    "Common structure every VC7B provider-cache-economics fixture validates against. `input.economics` is a ProviderEconomicsV1: integer MICRO-UNIT prices per token (basePrice uncached, readPrice cached-read, writePrice cached-write), the cache TTL in ms, the minimum cacheable prefix in tokens, and the conformance fixture ID proving the profile's exclusion set is safe (null only when the profile declares NO exclusions). MONEY IS INTEGER: prices are exact micro-units rather than floats, so the golden savings figures are exact and a corpus cannot drift from the provider's bill by float error. `input.scenario` dispatches the acceptance test to the real entry point: `economics` drives computeEconomics(economics, usage, evidence) asserting the exact baselineCost/actualCost/netSavings/tokenSavings (netSavings may be NEGATIVE and is never clamped - a prefix written once and never re-read really does lose money), `exclusion` drives validateEconomics asserting that a profile declaring exclusions without a proving fixture ID is REJECTED with ECON_EXCLUSION_UNPROVEN, `compile` drives compileCrystalBoundaries(ranges, limits) asserting the boundary/cacheable counts and - on every row - that request identity is preserved (the compiler chooses where boundaries FALL and never reorders, merges across a session, drops, or rewrites a range), `experiment` drives assignExperiment asserting the stable session-bucket arm and whether it is causally admissible (ONLY a randomized assignment is; forced and shadow rows are estimates excluded from causal intervals), and `eligibility` drives isCacheEligible against minPrefix/TTL. All rows are fed verbatim into the REAL production modules (src/vector-cortex/provider/{economics,experiments}.js, src/vector-cortex/cache/compiler.js), no mocks. Every span digest is a real SHA-256 over that range's own content and every golden savings figure is recomputed by the generator, never hand-written. The span and economics shapes are inlined rather than $ref'd because the conformance validator implements the schema subset our corpus uses; a $ref node would type-check as nothing and validate silently.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cache-economics"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: {
          type: "string",
          enum: [
            "ECON_EXCLUSION_UNPROVEN",
            "ECON_PRICE_INVALID",
            "ECON_USAGE_INVALID",
            "ECON_OVERFLOW",
            "COMP_RANGE_INVALID",
            "COMP_SEGMENT_LIMIT",
            "COMP_LIMIT_INVALID",
            "COMP_IDENTITY_DRIFT",
            "EXP_ID_INVALID",
            "EXP_SPLIT_INVALID",
            "EXP_ARM_UNKNOWN",
          ],
        },
        baselineCost: { type: "integer" },
        actualCost: { type: "integer" },
        netSavings: { type: "integer" },
        tokenSavings: { type: "integer" },
        savingsRatio: { type: "number" },
        breakEvenHits: { type: ["integer", "null"] },
        evidence: { type: "string", enum: ["measured", "estimate"] },
        boundaryCount: { type: "integer", minimum: 0 },
        cacheableCount: { type: "integer", minimum: 0 },
        identityPreserved: { type: "boolean" },
        arm: { type: "string", enum: ["A", "B", "C"] },
        source: { type: "string", enum: ["randomized", "forced", "shadow"] },
        causal: { type: "boolean" },
        stable: { type: "boolean" },
        eligible: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "mode"],
      properties: {
        scenario: {
          type: "string",
          enum: ["economics", "exclusion", "compile", "experiment", "eligibility"],
        },
        mode: { type: "string" },
        economics: econProfileSchema(),
        usage: {
          type: "object",
          required: ["cachedTokens", "writeCount", "hitCount"],
          properties: {
            cachedTokens: { type: "number" },
            writeCount: { type: "number" },
            hitCount: { type: "number" },
          },
        },
        evidence: { type: "string", enum: ["measured", "estimate"] },
        exclusions: {
          type: "array",
          items: {
            type: "object",
            required: ["pointer", "fixtureId", "proofDigest"],
            properties: {
              pointer: { type: "string" },
              fixtureId: { type: "string" },
              proofDigest: { type: "string" },
            },
          },
        },
        ranges: { type: "array", items: econSpanSchema() },
        limits: {
          type: "object",
          required: ["minPrefix", "maxSegments", "bytesPerToken"],
          properties: {
            minPrefix: { type: "integer", minimum: 0 },
            maxSegments: { type: "integer", minimum: 1 },
            bytesPerToken: { type: "integer", minimum: 1 },
          },
        },
        experiment: {
          type: "object",
          required: ["experimentId", "sessionId", "assignedAt"],
          properties: {
            experimentId: { type: "string" },
            sessionId: { type: "string" },
            assignedAt: { type: "integer" },
            forced: { type: "string", enum: ["A", "B", "C"] },
            shadow: { type: "boolean" },
          },
        },
        repeatAssignments: { type: "integer", minimum: 1 },
        loseJournalAfterFirst: { type: "boolean" },
        prefixTokens: { type: "integer", minimum: 0 },
        ageMs: { type: "integer", minimum: 0 },
      },
    },
  },
};

schemas["schemas/cache-diagnostic-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC7C cache-diagnostic fixture envelope",
  description:
    "Common structure every VC7C cache miss-classification fixture validates against. input.observe is a real MissObservation fed verbatim into the PURE classifier classifyMiss(observe) (no flag read, no network). expected.missClass is the EXACT exclusive class the production must return; expected.transient is whether isTransientMiss reports true. The classifier ranks profile -> range -> dependency -> request -> generation -> unknown and returns the FIRST true cause, so each fixture pins one rank boundary. Observation digests follow the VC digest convention: coveredDigest is sha256:<hex> WITH prefix; requestDigest is BARE lowercase hex. High-water marks are plain integers in the fixture (the production reads bigint; the acceptance test coerces).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["cache-diagnostic"] },
    expected: {
      type: "object",
      required: ["ok", "missClass"],
      properties: {
        ok: { type: "boolean" },
        missClass: {
          type: "string",
          enum: ["profile", "range", "dependency", "request", "generation", "unknown"],
        },
        transient: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["observe"],
      properties: {
        observe: {
          type: "object",
          required: [
            "requestProfileId",
            "requestProfileVersion",
            "requestCoveredDigest",
            "requestedRangeCount",
            "requestDigest",
            "requestDependencyHighWater",
            "generationInvalidated",
          ],
          properties: {
            requestProfileId: { type: "string" },
            requestProfileVersion: { type: ["string", "number"] },
            cachedProfileId: { type: ["string", "null"] },
            cachedProfileVersion: { type: ["string", "number", "null"] },
            requestCoveredDigest: { type: "string" },
            cachedCoveredDigest: { type: ["string", "null"] },
            requestedRangeCount: { type: "integer" },
            cachedRangeCount: { type: ["integer", "null"] },
            requestDigest: { type: "string" },
            cachedRequestDigest: { type: ["string", "null"] },
            requestDependencyHighWater: { type: "integer" },
            cachedDependencyHighWater: { type: ["integer", "null"] },
            generationInvalidated: { type: "boolean" },
          },
        },
      },
    },
  },
};

schemas["schemas/request-hash-v2-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC7C M5 request-hash-v2 migration fixture",
  description:
    "VC7C M5 request-hash-v2 migration fixture envelope. input describes v1 rows + economics versions + session/generation state; expected is the migration outcome (ok, codes, activeVersionAfter). The acceptance test constructs an in-memory M5Host from the input, runs migrateRequestHashV2(host), and compares the result. All digests are computed by node:crypto in the generator, never hand-written.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["request-hash-v2"] },
    expected: {
      type: "object",
      required: ["ok", "codes"],
      properties: {
        ok: { type: "boolean" },
        codes: { type: "array", items: { type: "string" } },
        activeVersionAfter: { type: "integer" },
        copied: { type: "integer" },
        identityPreserved: { type: "boolean" },
        v2Hash: { type: "string" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "v1Rows"],
      properties: {
        scenario: { type: "string" },
        activeVersion: { type: "integer" },
        econVersionOf: { type: "object" },
        sessionOf: { type: "object" },
        liveGenerationOf: { type: "object" },
        v1Rows: {
          type: "array",
          items: {
            type: "object",
            required: ["profileId", "requestDigest", "hash"],
            properties: {
              profileId: { type: "string" },
              requestDigest: { type: "string" },
              hash: { type: "string" },
            },
          },
        },
      },
    },
  },
};

schemas["schemas/outcome-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8A outcome fixture envelope",
  description:
    "Common structure every VC8A outcome fixture validates against. input is a payload-free OutcomeV1 (session/repo/assignment/metrics only, never prompt/response/exactBytes/freeText). expected pins the appendOutcome verdict (ok) or the OUT_PAYLOAD_FORBIDDEN code.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["outcome"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        outcomeId: { type: "string" },
      },
    },
    input: {
      type: "object",
      required: ["outcomeId", "sessionId", "repoId", "assignment", "metrics"],
      properties: {
        outcomeId: { type: "string" },
        sessionId: { type: "string" },
        repoId: { type: "string" },
        assignment: { type: "string" },
        metrics: {
          type: "array",
          items: {
            type: "object",
            required: ["code", "value", "unit"],
            properties: {
              code: { type: "string" },
              value: { type: "number" },
              unit: { type: "string" },
            },
          },
        },
        ts: { type: "string" },
      },
    },
  },
};

schemas["schemas/consent-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8A consent fixture envelope",
  description:
    "Common structure every VC8A consent fixture validates against. input has consent records, a sessionId, and an effective high-water; expected pins whether the session has active consent at that high-water.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["consent"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        hasActiveConsent: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      required: ["records", "sessionId", "effectiveHighWater"],
      properties: {
        records: {
          type: "array",
          items: {
            type: "object",
            required: ["consentId", "sessionId", "action", "effectiveSeq", "ts"],
            properties: {
              consentId: { type: "string" },
              sessionId: { type: "string" },
              action: { type: "string", enum: ["grant", "revoke"] },
              effectiveSeq: { type: "integer" },
              ts: { type: "string" },
            },
          },
        },
        sessionId: { type: "string" },
        effectiveHighWater: { type: "integer" },
      },
    },
  },
};

schemas["schemas/dataset-manifest-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8A dataset manifest fixture envelope",
  description:
    "Common structure every VC8A dataset manifest fixture validates against. input has outcomes, consentRecords, and a consent high-water; expected pins the buildManifest row count, split integrity (all rows for one session in one split), and digest reproducibility.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["dataset"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        rowCount: { type: "integer" },
        splitsForSession: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["outcomes", "consentRecords", "consentHighWater"],
      properties: {
        outcomes: {
          type: "array",
          items: {
            type: "object",
            required: ["outcomeId", "sessionId", "repoId", "assignment", "metrics"],
            properties: {
              outcomeId: { type: "string" },
              sessionId: { type: "string" },
              repoId: { type: "string" },
              assignment: { type: "string" },
              metrics: { type: "array", items: { type: "object" } },
              ts: { type: "string" },
            },
          },
        },
        consentRecords: {
          type: "array",
          items: { type: "object" },
        },
        consentHighWater: { type: "integer" },
      },
    },
  },
};

schemas["schemas/policy-decision-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8B policy decision fixture envelope",
  description:
    "Common structure every VC8B policy-decision fixture validates against. input has a decisionId, sessionId, a (possibly non-canonical) pressure label, a requested budget, and a window; expected pins the allowed action + post-clamp budget (or the exact rejection code).",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["policy-decision"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        action: { type: "string" },
        budget: { type: "number" },
        pressure: { type: "string" },
        reason: { type: "string" },
        empty: { type: "string" },
      },
    },
    input: {
      type: "object",
      required: ["decisionId", "sessionId", "pressure", "requestedBudget", "bounds", "ts"],
      properties: {
        decisionId: { type: "string" },
        sessionId: { type: "string" },
        pressure: { type: "string" },
        requestedBudget: { type: "number" },
        bounds: {
          type: "object",
          required: ["minBudget", "maxBudget"],
          properties: {
            minBudget: { type: "number" },
            maxBudget: { type: "number" },
          },
        },
        alternateRequestedBudget: { type: "number" },
        ts: { type: "string" },
      },
    },
  },
};

schemas["schemas/policy-shadow-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8B shadow fixture envelope",
  description:
    "Common structure every VC8B shadow fixture validates against. input has the canonical prompt bytes and the inputs to evaluate in shadow; expected pins promptUnchanged, liveMutations (always 0), and the evaluated row count.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["policy-shadow"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        promptUnchanged: { type: "boolean" },
        liveMutations: { type: "integer" },
        evaluated: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["promptBytes", "inputs"],
      properties: {
        promptBytes: { type: "string" },
        inputs: {
          type: "array",
          items: { type: "object" },
        },
      },
    },
  },
};

schemas["schemas/pressure-v2-fixture.schema.json"] = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC8B pressure-v2 migration fixture envelope",
  description:
    "Common structure every VC8B pressure-v2 fixture validates against. input has a scenario and legacy v1 rows (optionally an injected post-copy row); expected pins the migration outcome (ok / code) and the active version after.",
  type: "object",
  required: ["id", "producer", "assertion", "kind", "expected", "input"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["pressure-v2"] },
    expected: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        code: { type: "string" },
        activeVersionAfter: { type: "integer" },
        rowCount: { type: "integer" },
      },
    },
    input: {
      type: "object",
      required: ["scenario", "v1Rows"],
      properties: {
        scenario: { type: "string", enum: ["migrate", "resume", "inject-after-copy"] },
        v1Rows: {
          type: "array",
          items: {
            type: "object",
            required: ["sessionId", "label", "effectiveSeq", "ts"],
            properties: {
              sessionId: { type: "string" },
              label: { type: "string" },
              effectiveSeq: { type: "integer" },
              ts: { type: "string" },
            },
          },
        },
        injectedRow: {
          type: "object",
          required: ["sessionId", "label", "effectiveSeq", "ts"],
          properties: {
            sessionId: { type: "string" },
            label: { type: "string" },
            effectiveSeq: { type: "integer" },
            ts: { type: "string" },
          },
        },
      },
    },
  },
};
