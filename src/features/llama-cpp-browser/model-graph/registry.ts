import { z } from 'zod';
import { generateId } from '@/01-models/id';
import { idToRaw, type ModelGraphRegistrationId } from '@/01-models/ids';
import { modelGraphSourceDigest, type ModelGraphRegistration } from '@/01-models/model-graph-registry';
import { parseModelGraphDefinitions } from './definition';

/** This wire snapshot is captured before a request. It cannot be imported as a
 * definition: execution permission belongs to local Settings, not JSON authors. */
export const modelGraphRequestRegistrationSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  label: z.string().min(1).max(120),
  source: z.string().min(1).max(1024 * 1024),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rule: z.strictObject({ mode: z.enum(['whenArchitectureUnknown', 'replaceNative']), architecture: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), approvedSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export const modelGraphRequestRegistrationsSchema = z.array(modelGraphRequestRegistrationSchema).max(32).superRefine((entries, context) => {
  const ids = new Set<string>(), architectures = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    const size = new TextEncoder().encode(entry.source).length;
    bytes += size;
    if (size > 1024 * 1024 || bytes > 4 * 1024 * 1024 || ids.has(entry.id) || architectures.has(entry.rule.architecture)) {
      context.addIssue({ code: 'custom', message: 'Invalid, duplicate, or oversized model graph request registry' });
      return;
    }
    ids.add(entry.id);
    architectures.add(entry.rule.architecture);
  }
});
export type ModelGraphRequestRegistration = z.infer<typeof modelGraphRequestRegistrationSchema>;

export function importModelGraphRegistrations({ input, existing }: { input: string, existing: readonly ModelGraphRegistration[] }): ModelGraphRegistration[] {
  const parsed = parseModelGraphDefinitions({ input });
  if (existing.length + parsed.length > 32) {
    throw new Error('At most 32 model graph definitions can be stored');
  }
  const digests = new Set(existing.map(entry => entry.sourceSha256));
  return parsed.map(({ source, definition }) => {
    const sourceSha256 = modelGraphSourceDigest({ source });
    if (digests.has(sourceSha256)) {
      throw new Error('This model graph definition is already registered');
    }
    digests.add(sourceSha256);
    return { id: generateId<ModelGraphRegistrationId>(), label: definition.name, source, sourceSha256, rule: { mode: 'disabled' } };
  });
}

export function setModelGraphUseRule({ registration, mode, registrations }: {
  registration: ModelGraphRegistration, mode: ModelGraphRegistration['rule']['mode'], registrations: readonly ModelGraphRegistration[],
}): ModelGraphRegistration {
  switch (mode) {
  case 'disabled': return { ...registration, rule: { mode: 'disabled' } };
  case 'whenArchitectureUnknown': case 'replaceNative': break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  const parsed = parseModelGraphDefinitions({ input: registration.source });
  if (parsed.length !== 1 || !parsed[0]) {
    throw new Error('A registration must contain exactly one definition');
  }
  const architecture = parsed[0].definition.applicability.architecture;
  if (registrations.some(other => other.id !== registration.id && other.rule.mode !== 'disabled' && other.rule.architecture === architecture)) {
    throw new Error('Another enabled definition targets this architecture. Disable it first.');
  }
  const digest = modelGraphSourceDigest({ source: registration.source });
  if (digest !== registration.sourceSha256) {
    throw new Error('Definition changed. Replace it and review the new content before enabling it.');
  }
  return { ...registration, rule: { mode, architecture, approvedSha256: digest } };
}

export function modelGraphRequestRegistrations({ registrations }: { registrations: readonly ModelGraphRegistration[] }): ModelGraphRequestRegistration[] {
  const result: ModelGraphRequestRegistration[] = [];
  for (const registration of registrations) {
    const { id, label, source, sourceSha256, rule, ...rest } = registration;
    rest satisfies Record<PropertyKey, never>;
    switch (rule.mode) {
    case 'disabled': break;
    case 'replaceNative': case 'whenArchitectureUnknown': result.push({ id: idToRaw({ id }), label, source, sourceSha256, rule });
      break;
    default: {
      const exhaustive: never = rule;
      throw new Error(String(exhaustive));
    }
    }
  }
  return modelGraphRequestRegistrationsSchema.parse(result);
}

/** Select authority before parsing the definition. A broken matching override
 * blocks the operation; it is never filtered out to reveal a native fallback. */
export function selectModelGraphRegistration({ registrations, architecture, nativeRecognized }: {
  registrations: readonly ModelGraphRequestRegistration[], architecture: string, nativeRecognized: boolean,
}): ModelGraphRequestRegistration | undefined {
  const candidates = registrations.filter(entry => entry.rule.architecture === architecture && (entry.rule.mode === 'replaceNative' || !nativeRecognized));
  if (candidates.length > 1) {
    throw new Error('Conflicting model graph execution rules');
  }
  const selected = candidates[0];
  if (!selected) {
    return undefined;
  }
  if (selected.sourceSha256 !== selected.rule.approvedSha256 || selected.sourceSha256 !== modelGraphSourceDigest({ source: selected.source })) {
    throw new Error('Model graph approval is stale');
  }
  const definitions = parseModelGraphDefinitions({ input: selected.source });
  if (definitions.length !== 1 || definitions[0]?.definition.applicability.architecture !== architecture) {
    throw new Error('Model graph target changed after approval');
  }
  return selected;
}

export const TEST_ONLY = {
};
