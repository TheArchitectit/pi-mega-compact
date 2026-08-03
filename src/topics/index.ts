/**
 * index.ts — S51 topics barrel. Re-export only; no logic.
 */
export {
	loadEmbeddings,
	buildTopicModel,
	DEFAULT_CLUSTER_CONFIG,
	type WikiClusterConfig,
} from "./cluster.js";
export {
	createTopicStore,
	getWikiCompactCounter,
	bumpWikiCompactCounter,
	applyOverridesAfterRebuild,
} from "./store.js";
export { applyFullOverridesAfterRebuild } from "./durability.js";
export type { TopicStore, StoredTopic } from "./store.js";
export { tokenize, tfidfScores, labelFromScores, membershipConfidence } from "./labels.js";
export type {
	Topic,
	TopicAssignment,
	ClusterModel,
	EmbeddedChunk,
} from "./types.js";
