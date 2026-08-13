/**
 * bridge.ts — public barrel for the mega-compact bidirectional bridge.
 *
 * Hosts import only this file. The factory and all contracts live under
 * src/bridge/ (kept thin per the delegate-shell pattern).
 */
export type {
  MegaBridge,
  BridgeOptions,
  BridgeMessage,
  BridgeCompactInput,
  BridgeCompactResult,
  BridgeRecallOptions,
  BridgeRecallResult,
  BridgeMemoryRecallOptions,
  BridgeMemoryRecallResult,
  BridgeForkOptions,
  BridgeForkResult,
  BridgeCortexOptions,
  BridgeCortexResult,
  BridgeAddMemoryInput,
  BridgeRecordTurnInput,
} from "./bridge/types.js";
export { createMegaBridge } from "./bridge/factory.js";
