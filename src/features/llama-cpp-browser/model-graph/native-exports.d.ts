/* eslint-disable local-rules-named-args/require-named-args -- Generated fixed-width C ABI. */
/** Generated from bridge/model-graph.h; synchronous optional extension. */
export interface ModelGraphNativeExports {
  _lcb_model_graph_architecture_known(name: bigint): number;
  _lcb_model_graph_last_error(): bigint;
  _lcb_model_graph_sample(workspace: bigint, sampler: bigint, logits: bigint, count: number): number;
  _lcb_model_graph_sampler_workspace_free(workspace: bigint): void;
  _lcb_model_graph_sampler_workspace_new(vocabulary_size: number): bigint;
  _lcb_model_graph_schema_hash(): bigint;
  _lcb_model_graph_version(): number;
  _lcb_model_graph_vocab_free(owner: bigint): void;
  _lcb_model_graph_vocab_get(owner: bigint): bigint;
  _lcb_model_graph_vocab_new(metadata: bigint): bigint;
}
