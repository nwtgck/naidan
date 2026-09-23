import { z } from 'zod';
import { PWA_PROTOCOL } from './protocol';

// Additive to v1: older pages/workers may ignore this notification. Never infer
// a successful install from its absence; browser termination cannot report it.
export const pwaInstallFailureSchema = z.object({
  protocol: z.literal(PWA_PROTOCOL),
  type: z.literal('precache-failed'),
  scope: z.string().max(4096),
  buildId: z.string().min(1).max(200),
  resourceUrl: z.string().max(4096),
  error: z.object({
    name: z.string().max(200),
    message: z.string().max(4096),
    stack: z.string().max(16000).optional(),
    status: z.number().int().min(0).max(599).optional(),
  }).strict(),
}).strict();

export type PWAInstallFailure = z.infer<typeof pwaInstallFailureSchema>;

const responseErrorSchema = z.object({
  details: z.object({ status: z.number().int().min(0).max(599) }),
});

/** Only bounded diagnostic fields cross the worker boundary, never responses. */
export function createPWAInstallFailure({ scope, buildId, resourceUrl, error }: {
  scope: string;
  buildId: string;
  resourceUrl: string;
  error: Error;
}): PWAInstallFailure {
  const responseError = responseErrorSchema.safeParse(error);
  return pwaInstallFailureSchema.parse({
    protocol: PWA_PROTOCOL,
    type: 'precache-failed',
    scope,
    buildId,
    resourceUrl,
    error: {
      name: error.name.slice(0, 200),
      message: error.message.slice(0, 4096),
      ...(error.stack ? { stack: error.stack.slice(0, 16000) } : {}),
      ...(responseError.success ? { status: responseError.data.details.status } : {}),
    },
  });
}

export const TEST_ONLY = {
};
