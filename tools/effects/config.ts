import type { VueEffectModel } from './models/packages/vue.ts';
import type { WorkerTransportModel } from './bridges/worker-transport.ts';
import type { EffectDefinition } from './models/registry.ts';

export type ExternalEffectModel = {
  /** Exact declaration path, relative to the repository root; never just a callee name. */
  file: string,
  export: string,
  effects: readonly string[],
  returnValue: 'scalar' | 'promise-scalar' | 'scalar-value',
  /** Digest of the reviewed declaration/implementation. This is a trust boundary, not a proof. */
  sha256: string,
};
export type EffectsConfig = {
  /** Explicit initial rollout; this does not narrow the eventual all-function goal. */
  files: readonly string[],
  tsconfig: string,
  definitions: readonly EffectDefinition[],
  models: readonly ExternalEffectModel[],
  workerTransports: readonly WorkerTransportModel[],
  vueModels: readonly VueEffectModel[],
  analysisBudget: number,
};

// Configuration is an executable module, but its exported data still has a checked boundary.
