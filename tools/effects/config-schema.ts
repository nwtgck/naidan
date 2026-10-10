import { z } from 'zod';
import { parseEffectRow } from './syntax/expression.ts';
import { effectRowSchema } from './syntax/schema.ts';

const configSchema = z.strictObject({
  /** Explicit source entries; local dependencies are analyzed transitively. */
  files: z.array(z.string().min(1)).min(1),
  tsconfig: z.string().min(1),
  definitions: z.array(z.strictObject({ name: z.string().min(1), arguments: z.enum(['resource', 'none']) })),
  models: z.array(z.strictObject({
    /** Exact declaration path, relative to the repository root; never just a callee name. */
    file: z.string().min(1),
    export: z.string().min(1),
    effects: effectRowSchema,
    returnValue: z.enum(['scalar', 'promise-scalar', 'scalar-value']),
    /** Digest of the reviewed declaration/implementation. This is a trust boundary, not a proof. */
    sha256: z.string().length(64),
  })),
  workerTransports: z.array(z.strictObject({ file: z.string().min(1), sha256: z.string().length(64), wrapExport: z.string().min(1), exposeExport: z.string().min(1) })),
  vueModels: z.array(z.strictObject({ file: z.string().min(1), sha256: z.string().length(64) })),
  analysisBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

type ConfigData = z.infer<typeof configSchema>;
export type ExternalEffectModel = Omit<ConfigData['models'][number], 'effects'> & {
  effects: Readonly<ConfigData['models'][number]['effects']>,
};
// Preserve the readonly public view without freezing parsed runtime arrays.
export type EffectsConfig = Omit<ConfigData, 'files' | 'definitions' | 'models' | 'workerTransports' | 'vueModels'> & {
  files: Readonly<ConfigData['files']>,
  definitions: Readonly<ConfigData['definitions']>,
  models: readonly ExternalEffectModel[],
  workerTransports: Readonly<ConfigData['workerTransports']>,
  vueModels: Readonly<ConfigData['vueModels']>,
};

export function parseEffectsConfig({ value }: { value: unknown }): EffectsConfig {
  const config = configSchema.parse(value);
  const names = new Set<string>();
  for (const definition of config.definitions) {
    if (names.has(definition.name) || definition.name === 'none' || definition.name === 'call') throw new Error(`Duplicate or reserved effect name: ${definition.name}`);
    names.add(definition.name);
  }
  for (const model of config.models) {
    parseEffectRow({ value: model.effects, definitions: config.definitions });
    if (model.returnValue === 'scalar-value' && model.effects.length > 0) throw new Error('A scalar-value boundary cannot hide effectful access.');
  }
  return config;
}
