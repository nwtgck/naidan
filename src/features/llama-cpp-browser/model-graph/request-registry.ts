import { z } from 'zod';
import { idToRaw } from '@/01-models/ids';
import type { ModelGraphRegistration } from '@/01-models/model-graph-registry';

// This small transport boundary is eagerly shared by the UI and Workers.
// Keep declaration parsing and the operator catalog behind registered-graph
// execution/settings imports; native-model startup must not load them.
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
export const TEST_ONLY = {
};
