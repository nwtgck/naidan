import { idToRaw, toModelGraphRegistrationId } from '@/01-models/ids';
import type { ModelGraphRegistration, ModelGraphUseRule } from '@/01-models/model-graph-registry';
import type { ExperimentalModelGraphRegistrationDto } from '@/00-storage/00-dto/experimental-model-graph.dto';
import { exactObject } from '@/utils/exact-object';

function copyRule({ rule }: { rule: ModelGraphUseRule }): ModelGraphUseRule {
  switch (rule.mode) {
  case 'disabled': return { mode: 'disabled' };
  case 'when_architecture_unknown': case 'replace_native': {
    const { mode, architecture, approvedSha256, ...rest } = rule;
    rest satisfies Record<PropertyKey, never>;
    return { mode, architecture, approvedSha256 };
  }
  default: {
    const exhaustive: never = rule;
    throw new Error(String(exhaustive));
  }
  }
}

export function modelGraphRegistrationFromDto({ value }: { value: ExperimentalModelGraphRegistrationDto }): ModelGraphRegistration {
  const { id, label, source, sourceSha256, rule, ...rest } = value;
  rest satisfies Record<PropertyKey, never>;
  return exactObject<ModelGraphRegistration>()({ id: toModelGraphRegistrationId({ raw: id }), label, source, sourceSha256, rule: copyRule({ rule }) });
}

export function modelGraphRegistrationToDto({ registration }: { registration: ModelGraphRegistration }): ExperimentalModelGraphRegistrationDto {
  const { id, label, source, sourceSha256, rule, ...rest } = registration;
  rest satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalModelGraphRegistrationDto>()({ id: idToRaw({ id }), label, source, sourceSha256, rule: copyRule({ rule }) });
}

export const TEST_ONLY = {
};
