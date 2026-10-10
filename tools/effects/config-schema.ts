import { z } from 'zod';
import type { EffectsConfig } from './config.ts';

const configSchema = z.strictObject({
  files: z.array(z.string().min(1)).min(1),
  tsconfig: z.string().min(1),
  definitions: z.array(z.strictObject({ name: z.string().min(1), arguments: z.enum(['resource', 'none']) })),
  models: z.array(z.strictObject({
    file: z.string().min(1),
    export: z.string().min(1),
    effects: z.array(z.string()),
    returnValue: z.enum(['scalar', 'promise-scalar', 'scalar-value']),
    sha256: z.string().length(64),
  })),
  workerTransports: z.array(z.strictObject({ file: z.string().min(1), sha256: z.string().length(64), wrapExport: z.string().min(1), exposeExport: z.string().min(1) })),
  vueModels: z.array(z.strictObject({ file: z.string().min(1), sha256: z.string().length(64) })),
  analysisBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export function parseEffectsConfig({ value }: { value: unknown }): EffectsConfig {
  const config = configSchema.parse(value);
  const names = new Set<string>();
  for (const definition of config.definitions) {
    if (names.has(definition.name) || definition.name === 'none' || definition.name === 'call') throw new Error(`Duplicate or reserved effect name: ${definition.name}`);
    names.add(definition.name);
  }
  for (const model of config.models) {
    if (model.returnValue === 'scalar-value' && model.effects.length > 0) throw new Error('A scalar-value boundary cannot hide effectful access.');
  }
  return config;
}
