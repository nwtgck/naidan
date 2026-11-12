import * as dtozod from '@/utils/dtozod';

// Experimental declarations intentionally have no backward execution guarantee.
// The envelope keeps source text intact so unsupported declarations are visible
// and recoverable, rather than silently disappearing on an application update.
export const ExperimentalModelGraphRuleSchemaDto = dtozod.union([
  dtozod.object({ mode: dtozod.literal('disabled') }),
  dtozod.object({ mode: dtozod.enum(['when_architecture_unknown', 'replace_native']), architecture: dtozod.string(), approvedSha256: dtozod.string() }),
]);
export const ExperimentalModelGraphRegistrationSchemaDto = dtozod.object({
  id: dtozod.string(),
  label: dtozod.string(),
  source: dtozod.string(),
  sourceSha256: dtozod.string(),
  rule: ExperimentalModelGraphRuleSchemaDto,
});
export const ExperimentalModelGraphRegistrySchemaDto = dtozod.object({
  version: dtozod.literal(1),
  id: dtozod.string(),
  revision: dtozod.number(),
  registrations: dtozod.array(ExperimentalModelGraphRegistrationSchemaDto),
});
export type ExperimentalModelGraphRegistrationDto = dtozod.infer<typeof ExperimentalModelGraphRegistrationSchemaDto>;
export type ExperimentalModelGraphRegistryDto = dtozod.infer<typeof ExperimentalModelGraphRegistrySchemaDto>;
export const TEST_ONLY = {
};
