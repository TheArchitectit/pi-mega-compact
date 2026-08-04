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
