import { describe, expect, it } from 'vitest';
import { ExperimentalModelGraphRegistrationSchemaDto, ExperimentalModelGraphRuleSchemaDto } from '@/00-storage/00-dto/experimental-model-graph.dto';
import { idToRaw, toModelGraphRegistrationId } from '@/01-models/ids';
import { modelGraphSourceDigest, type ModelGraphRegistration, type ModelGraphUseRule } from '@/01-models/model-graph-registry';
import { modelGraphRegistrationFromDto, modelGraphRegistrationToDto } from './model-graph';

const source = '{"format":"experimental-fixture"}';
const digest = modelGraphSourceDigest({ source });
const rules = [
  { mode: 'disabled' },
  { mode: 'when_architecture_unknown', architecture: 'fixture', approvedSha256: digest },
  { mode: 'replace_native', architecture: 'fixture', approvedSha256: digest },
] satisfies ModelGraphUseRule[];

function registration({ rule }: { rule: ModelGraphUseRule }): ModelGraphRegistration {
  return {
    id: toModelGraphRegistrationId({ raw: 'registration-fixture' }),
    label: 'Fixture',
    source,
    sourceSha256: digest,
    rule,
  };
}

describe('model graph registration DTO', () => {
  it.each(rules)('round-trips the $mode rule and its approval unchanged', rule => {
    const value = registration({ rule });
    const dto = ExperimentalModelGraphRegistrationSchemaDto.parse(modelGraphRegistrationToDto({ registration: value }));
    expect(dto).toEqual({ id: idToRaw({ id: value.id }), label: value.label, source, sourceSha256: digest, rule });
    const restored = modelGraphRegistrationFromDto({ value: dto });
    expect(restored).toEqual(value);
    expect(restored).not.toBe(value);
    expect(restored.rule).not.toBe(dto.rule);
    expect(modelGraphRegistrationToDto({ registration: restored })).toEqual(dto);
  });

  it.each(['whenArchitectureUnknown', 'replaceNative'])('rejects the unreleased %s spelling without compatibility conversion', mode => {
    expect(ExperimentalModelGraphRuleSchemaDto.safeParse({ mode, architecture: 'fixture', approvedSha256: digest }).success).toBe(false);
  });
});
