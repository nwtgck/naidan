import { z } from 'zod';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';

// These messages carry only explicit development instrumentation. They never
// change request shapes or introduce a prerequisite for normal fetch readiness.
// Raw managed additions are independent of the bounded diagnostic AST cache.
export const developmentMetaCspSyncMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('development-meta-csp-sync'),
  sessionId: z.string().min(1),
  syncId: z.string().min(1),
  policies: z.array(z.string()),
}).strict();

export const developmentMetaCspResultMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('development-meta-csp-result'),
  sessionId: z.string().min(1),
  syncId: z.string().min(1),
  confirmedPolicyCount: z.number().int().nonnegative(),
  outcome: z.enum(['added', 'partly-added', 'unavailable']),
}).strict();

export type DevelopmentMetaCspSyncMessage = z.infer<typeof developmentMetaCspSyncMessageSchema>;
export type DevelopmentMetaCspResultMessage = z.infer<typeof developmentMetaCspResultMessageSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
