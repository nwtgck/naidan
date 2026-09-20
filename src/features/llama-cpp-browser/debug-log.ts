import { z } from 'zod';
import { errorCode, errorCodeSchema } from './types';

const stageSchema = z.enum(['model-resolve', 'projector-load', 'image-decode', 'image-tokenize', 'image-evaluate', 'session', 'prefill', 'template', 'tokenize', 'prefill-decode', 'sampler-create',
  'reasoning-state', 'grammar-switch', 'native-sample', 'reasoning-accept', 'reasoning-replay',
  'token-render', 'partial-parse', 'stream-emit', 'generation-decode', 'final-parse', 'cleanup',
  'worker-operation', 'worker-callback', 'worker-rpc', 'worker-error', 'worker-messageerror']);
export type DiagnosticStage = z.infer<typeof stageSchema>;
const failureKindSchema = z.enum(['wasm-trap', 'native-exception', 'binding-error', 'type-error', 'range-error',
  'validation-error', 'abort-error', 'javascript-error', 'unknown-exception']);

const diagnosticSchema = z.object({
  event: z.enum(['import-start', 'import-complete', 'runtime-ready', 'load-complete',
    'load-start', 'model-reused', 'context-start', 'context-ready', 'context-retry', 'cache-reuse', 'prefill-start', 'prefill-complete', 'generation-start', 'sampler-ready', 'first-token-sampled', 'generation-complete', 'cancelled', 'released', 'failed']),
  stage: stageSchema.optional(),
  failureKind: failureKindSchema.optional(),
  code: errorCodeSchema.optional(),
  reason: z.enum(['model-directory-layout', 'non-monotonic-content', 'non-monotonic-reasoning', 'decode-status', 'invalid-token-piece', 'missing-native-binding', 'context-allocation', 'prefix-match', 'prefix-mismatch', 'cache-invalid', 'cache-position']).optional(),
  grammar: z.boolean().optional(),
  grammarLazy: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  pointerBytes: z.union([z.literal(4), z.literal(8)]).optional(),
  contextTokens: z.number().int().positive().optional(),
  reusedTokens: z.number().int().nonnegative().optional(),
  evaluatedTokens: z.number().int().nonnegative().optional(),
  imageCount: z.number().int().nonnegative().optional(),
  toolCount: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
  bytes: z.number().finite().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  profile: z.enum(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi']).optional(),
}).strict();
const stageDescriptions = {
  'model-resolve': 'resolving the model directory layout',
  'projector-load': 'loading the matching image projector',
  'image-decode': 'decoding an image with the browser',
  'image-tokenize': 'preparing image and text chunks with native mtmd',
  'image-evaluate': 'evaluating image and text chunks with native mtmd',
  session: 'preparing the resident model and context',
  prefill: 'preparing the prompt evaluation',
  template: 'applying the native chat template',
  tokenize: 'tokenizing the prompt',
  'prefill-decode': 'evaluating the prompt tokens',
  'sampler-create': 'creating the native sampling and grammar state',
  'reasoning-state': 'reading the native reasoning state',
  'grammar-switch': 'attaching or detaching the grammar sampler',
  'native-sample': 'selecting the next token with the native sampler',
  'reasoning-accept': 'advancing the native reasoning state',
  'reasoning-replay': 'replaying the reasoning end marker into the grammar',
  'token-render': 'converting a generated token into text',
  'partial-parse': 'parsing partial generated output with the native chat parser',
  'stream-emit': 'delivering parsed output to the response stream',
  'generation-decode': 'evaluating the next generated token',
  'final-parse': 'parsing the completed generated output',
  cleanup: 'releasing generation resources',
  'worker-operation': 'running an operation inside the inference worker',
  'worker-callback': 'delivering a worker progress or output callback',
  'worker-rpc': 'waiting for the inference worker response',
  'worker-error': 'handling an inference worker error event',
  'worker-messageerror': 'deserializing an inference worker message',
} satisfies Record<DiagnosticStage, string>;
const failureDescriptions = {
  'wasm-trap': 'WebAssembly reported a runtime trap.',
  'native-exception': 'A numeric native exception was thrown.',
  'binding-error': 'The native JavaScript binding rejected the operation.',
  'type-error': 'JavaScript reported an incompatible value type.',
  'range-error': 'JavaScript reported a value outside the allowed range.',
  'validation-error': 'Data did not match the expected boundary schema.',
  'abort-error': 'The operation was interrupted.',
  'javascript-error': 'JavaScript reported an error.',
  'unknown-exception': 'The exception could not be classified safely.',
} satisfies Record<z.infer<typeof failureKindSchema>, string>;
const reasonDescriptions = {
  'model-directory-layout': 'Expected one model or a complete split set, with at most one projector candidate.',
  'context-allocation': 'Context allocation returned no context; retrying a smaller capacity.',
  'prefix-match': 'Reusing the complete decoded token prefix.',
  'prefix-mismatch': 'The prompt changed before the end of the decoded prefix; evaluating it again.',
  'cache-invalid': 'No verified decoded prefix is available; evaluating the full prompt.',
  'cache-position': 'Native memory does not match the recorded token frontier; evaluating the full prompt.',
  'missing-native-binding': 'The installed runtime must be updated to provide the owned reasoning end-match binding.',
  'non-monotonic-content': 'The parser revised content that had already been streamed.',
  'non-monotonic-reasoning': 'The parser revised reasoning that had already been streamed.',
  'decode-status': 'Native token evaluation returned an unsuccessful status.',
  'invalid-token-piece': 'Native token rendering returned an invalid buffer length.',
} satisfies Record<NonNullable<z.infer<typeof diagnosticSchema>['reason']>, string>;

/** Allowlisted fields only: never forward native logs, errors, names or chat data. */
export function logDiagnostic({ diagnostic }: { diagnostic: z.infer<typeof diagnosticSchema> }): void {
  const safe = diagnosticSchema.safeParse(diagnostic);
  if (!safe.success) return;
  switch (safe.data.event) {
  case 'failed': {
    const { stage, failureKind, reason } = safe.data;
    // Descriptions come only from local closed dictionaries, never from the caller.
    const message = [
      stage ? `Failed while ${stageDescriptions[stage]}.` : 'The runtime operation failed.',
      failureKind ? failureDescriptions[failureKind] : undefined,
      reason ? reasonDescriptions[reason] : undefined,
    ].filter(value => value !== undefined).join(' ');
    console.debug('[llama-cpp-browser]', { ...safe.data, message });
    return;
  }
  case 'import-start': case 'import-complete': case 'runtime-ready': case 'load-complete':
  case 'load-start': case 'model-reused': case 'context-start': case 'context-ready':
  case 'prefill-start': case 'prefill-complete': case 'generation-start': case 'sampler-ready':
  case 'context-retry': case 'cache-reuse':
  case 'first-token-sampled': case 'generation-complete': case 'cancelled': case 'released':
    console.debug('[llama-cpp-browser]', safe.data); return;
  default: { const exhaustive: never = safe.data.event; throw new Error(`Unknown diagnostic event: ${exhaustive}`); }
  }
}
/** Classify locally without serializing exception values, messages or stacks. */
export function logFailure({ stage, error }: { stage: DiagnosticStage, error: unknown }): void {
  let failureKind: z.infer<typeof failureKindSchema>;
  if (error instanceof WebAssembly.RuntimeError) failureKind = 'wasm-trap';
  else if (typeof error === 'number' || typeof error === 'bigint') failureKind = 'native-exception';
  else if (error instanceof z.ZodError) failureKind = 'validation-error';
  else if (error instanceof TypeError) failureKind = 'type-error';
  else if (error instanceof RangeError) failureKind = 'range-error';
  else if (error instanceof DOMException && error.name === 'AbortError') failureKind = 'abort-error';
  else if (error instanceof Error && (error.name === 'BindingError' || error.name === 'UnboundTypeError')) failureKind = 'binding-error';
  else if (error instanceof Error) failureKind = 'javascript-error';
  else failureKind = 'unknown-exception';
  logDiagnostic({ diagnostic: { event: 'failed', stage, failureKind, code: errorCode({ error }) } });
}
export const TEST_ONLY = {
};
