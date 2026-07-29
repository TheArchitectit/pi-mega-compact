/**
 * index.ts — S51 topics barrel. Re-export only; no logic.
 */
export { loadEmbeddings, buildTopicModel, DEFAULT_CLUSTER_CONFIG } from "./cluster.js";
export type { WikiClusterConfig } from "./cluster.js";
export { tokenize, tfidfScores, labelFromScores, membershipConfidence } from "./labels.js";
export type {
	Topic,
	TopicAssignment,
	ClusterModel,
	EmbeddedChunk,
} from "./types.js";
