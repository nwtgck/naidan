import { z } from 'zod'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'

const privacyFetchHeaderEntrySchema = z.tuple([z.string(), z.string()])

export const privacyFetchHeaderEntriesSchema = z.array(privacyFetchHeaderEntrySchema)

export const privacyFetchValidationAcceptedResultSchema = z.object({
  ok: z.literal(true),
  policyName: z.string().min(1),
  normalizedUrl: z.string().url(),
}).strict()

export const privacyFetchValidationRejectedCodeSchema = z.enum([
  'invalid_url',
  'invalid_protocol',
  'invalid_username_or_password',
  'invalid_port',
  'invalid_hash',
  'invalid_hostname',
  'invalid_pathname',
  'invalid_query_parameter',
  'duplicate_query_parameter',
  'invalid_query_parameter_value',
  'unsupported_policy',
])

export const privacyFetchValidationRejectedResultSchema = z.object({
  ok: z.literal(false),
  code: privacyFetchValidationRejectedCodeSchema,
  message: z.string().min(1),
}).strict()

export const privacyFetchRequestMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('request'),
  requestId: z.string().min(1),
  url: z.string().url(),
}).strict()

export const privacyFetchCancelMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('cancel'),
  requestId: z.string().min(1),
}).strict()

export const privacyFetchReadyMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('ready'),
  capabilities: z.object({
    responseBody: z.literal('arrayBuffer'),
    transferArrayBuffer: z.literal(true),
    headers: z.literal('entries'),
  }).strict(),
}).strict()

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

const arrayBufferSchema = z.custom<ArrayBuffer>((value) => isArrayBuffer(value))

export const privacyFetchResponseMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('response'),
  requestId: z.string().min(1),
  ok: z.literal(true),
  url: z.string().url(),
  status: z.number().int().nonnegative(),
  statusText: z.string(),
  redirected: z.boolean(),
  responseType: z.string(),
  headers: privacyFetchHeaderEntriesSchema,
  body: arrayBufferSchema,
  bodyByteLength: z.number().int().nonnegative(),
  validationResult: privacyFetchValidationAcceptedResultSchema,
}).strict()

export const privacyFetchRejectedMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('rejected'),
  requestId: z.string().min(1),
  ok: z.literal(false),
  validationResult: privacyFetchValidationRejectedResultSchema,
}).strict()

export const privacyFetchErrorMessageSchema = z.object({
  protocol: z.literal(PRIVACY_FETCH_PROTOCOL),
  type: z.literal('error'),
  requestId: z.string().min(1),
  ok: z.literal(false),
  code: z.enum([
    'fetch_failed',
    'aborted',
    'duplicate_request_id',
  ]),
  message: z.string().min(1),
}).strict()

export const privacyFetchParentToBrokerMessageSchema = z.union([
  privacyFetchRequestMessageSchema,
  privacyFetchCancelMessageSchema,
])

export const privacyFetchBrokerToParentMessageSchema = z.union([
  privacyFetchReadyMessageSchema,
  privacyFetchResponseMessageSchema,
  privacyFetchRejectedMessageSchema,
  privacyFetchErrorMessageSchema,
])
