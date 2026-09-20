import { z } from 'zod';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';

export const streamRequestSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('stream-request'),
  url: z.string().url(),
  headers: z.array(z.tuple([z.string(), z.string()])).optional(),
}).strict();

export const streamResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('headers'),
    url: z.string().url(),
    status: z.number().int().min(0).max(599),
    statusText: z.string(),
    ok: z.boolean(),
    redirected: z.boolean(),
    responseType: z.string(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    policyName: z.string(),
  }).strict(),
  z.object({ type: z.literal('chunk'), body: z.custom<ArrayBuffer>(value => Object.prototype.toString.call(value) === '[object ArrayBuffer]') }).strict(),
  z.object({ type: z.literal('end') }).strict(),
  z.object({ type: z.literal('error'), code: z.enum(['fetch_failed', 'aborted', 'rejected']), message: z.string() }).strict(),
]);

export const TEST_ONLY = {
};
