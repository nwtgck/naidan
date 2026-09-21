import { z } from 'zod';
import { errorCode, errorCodeSchema, profileSchema } from './types';

const stageSchema = z.enum(['media-encode', 'media-decode', 'model-resolve', 'projector-trace', 'projector-load', 'image-decode', 'image-tokenize', 'image-evaluate', 'session', 'cache-probe', 'prefill', 'template', 'tokenize', 'prefill-decode', 'sampler-create',
  'reasoning-state', 'grammar-switch', 'native-sample', 'reasoning-accept', 'reasoning-replay',
  'token-render', 'partial-parse', 'stream-emit', 'generation-decode', 'final-parse', 'cleanup',
  'worker-operation', 'worker-callback', 'worker-rpc', 'worker-error', 'worker-messageerror']);
export type DiagnosticStage = z.infer<typeof stageSchema>;
const failureKindSchema = z.enum(['wasm-trap', 'native-exception', 'binding-error', 'type-error', 'range-error',
  'webgpu-dispatch-limit', 'webgpu-validation', 'webgpu-device-error', 'webgpu-device-lost', 'native-graph-error', 'native-output-mismatch', 'validation-error', 'abort-error', 'javascript-error', 'unknown-exception']);
const nativeMetricSchema = z.enum(['n_ctx', 'n_ctx_seq', 'n_batch', 'n_ubatch', 'n_seq_max', 'graph_nodes', 'graph_splits', 'compute_buffer_mib', 'model_buffer_mib']);

const eventSchema = z.enum(['import-start', 'import-complete', 'runtime-ready', 'load-complete',
  'load-start', 'model-reused', 'context-start', 'context-ready', 'context-retry', 'cache-reuse', 'prefill-start', 'prefill-complete', 'generation-start', 'sampler-ready', 'first-token-sampled', 'generation-complete', 'cancelled', 'released', 'failed', 'operation-start', 'operation-complete', 'operation-waiting', 'native-error', 'native-info', 'native-node-start', 'native-node-complete']);
export const diagnosticSchema = z.object({
  event: eventSchema,
  lastStage: stageSchema.optional(),
  lastEvent: eventSchema.optional(),
  stage: stageSchema.optional(),
  failureKind: failureKindSchema.optional(),
  code: errorCodeSchema.optional(),
  reason: z.enum(['model-directory-layout', 'non-monotonic-content', 'non-monotonic-reasoning', 'decode-status', 'invalid-token-piece', 'missing-native-binding', 'context-allocation', 'prefix-match', 'prefix-partial-match', 'prefix-mismatch', 'cache-invalid', 'cache-position', 'cache-window', 'cache-rollback-failed']).optional(),
  grammar: z.boolean().optional(),
  grammarLazy: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  pointerBytes: z.union([z.literal(4), z.literal(8)]).optional(),
  contextTokens: z.number().int().positive().optional(),
  reusedTokens: z.number().int().nonnegative().optional(),
  evaluatedTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  commonPrefixTokens: z.number().int().nonnegative().optional(),
  cacheComparison: z.enum(['empty-cache', 'identical', 'prompt-extension', 'prompt-shorter', 'token-mismatch']).optional(),
  nativeMemoryKind: z.enum(['none', 'attention', 'recurrent', 'hybrid']).optional(),
  nativePositionMin: z.number().int().min(-1).optional(),
  nativePositionMax: z.number().int().min(-1).optional(),
  nativeRollbackTokens: z.number().int().nonnegative().optional(),
  cacheRemoval: z.enum(['none', 'full-only', 'bounded', 'partial']).optional(),
  mediaType: z.enum(['image', 'audio']).optional(),
  batchIndex: z.number().int().positive().max(2147483647).optional(),
  batchCount: z.number().int().positive().max(2147483647).optional(),
  batchTokens: z.number().int().positive().max(2147483647).optional(),
  imageIndex: z.number().int().nonnegative().optional(),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  chunkCount: z.number().int().nonnegative().optional(),
  positions: z.number().int().nonnegative().optional(),
  nextPosition: z.number().int().nonnegative().optional(),
  dispatchAxis: z.enum(['x', 'y', 'z']).optional(),
  dispatchCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  dispatchLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  statusCode: z.number().int().optional(),
  imageCount: z.number().int().nonnegative().optional(),
  toolCount: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
  bytes: z.number().finite().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  expectedTokens: z.number().int().nonnegative().optional(),
  profile: profileSchema.optional(),
  nativeNode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  nativeOp: z.number().int().nonnegative().optional(),
  // Values originate only from generated GGML_OP constants, never tensor names.
  nativeOpName: z.string().regex(/^GGML_OP_[A-Z0-9_]{1,48}$/).optional(),
  nativeTensorType: z.number().int().nonnegative().optional(),
  nativeTensorShape: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).length(4).optional(),
  nativeMetric: nativeMetricSchema.optional(),
  nativeValue: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  nativeSingleTokenValue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  nativeBackend: z.enum(['CPU', 'CPU_Mapped', 'WebGPU']).optional(),
  nativeOperation: z.enum(['encode-batch', 'copy-image', 'output-embedding', 'preprocess-image']).optional(),
  nativeEntries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  nativeGridX: z.number().int().min(-2147483648).max(2147483647).optional(),
  nativeGridY: z.number().int().min(-2147483648).max(2147483647).optional(),
  nativeOverview: z.boolean().optional(),
  nativeShape: z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]).optional(),
}).strict();
const stageDescriptions = {
  'media-encode': 'encoding image or audio embeddings with native mtmd',
  'media-decode': 'evaluating a media embedding batch with the language model',
  'model-resolve': 'resolving the model directory layout',
  'projector-trace': 'reading native image encoder tensor metadata',
  'projector-load': 'loading the matching image projector',
  'image-decode': 'decoding an image with the browser',
  'image-tokenize': 'preparing image and text chunks with native mtmd',
  'image-evaluate': 'evaluating image and text chunks with native mtmd',
  session: 'preparing the resident model and context',
  'cache-probe': 'checking native sequence removal on a new context',
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
  'native-graph-error': 'Native image graph evaluation returned an error status.',
  'native-output-mismatch': 'Native image output token count did not match the expected count.',
  'webgpu-dispatch-limit': 'WebGPU dispatch exceeded the device workgroup limit.',
  'webgpu-device-error': 'WebGPU reported a device error.',
  'webgpu-validation': 'WebGPU rejected an invalid GPU operation.',
  'webgpu-device-lost': 'The WebGPU device was lost.',
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
  'prefix-partial-match': 'Reusing the common token prefix after removing the changed suffix.',
  'prefix-mismatch': 'The prompt changed before the end of the decoded prefix; evaluating it again.',
  'cache-invalid': 'No verified decoded prefix is available; evaluating the full prompt.',
  'cache-window': 'Earlier native cache positions are no longer retained; evaluating the full prompt.',
  'cache-rollback-failed': 'Native suffix removal could not be verified; evaluating the full prompt.',
  'cache-position': 'Native memory does not match the recorded token frontier; evaluating the full prompt.',
  'missing-native-binding': 'The installed runtime must be updated to provide the owned reasoning end-match binding.',
  'non-monotonic-content': 'The parser revised content that had already been streamed.',
  'non-monotonic-reasoning': 'The parser revised reasoning that had already been streamed.',
  'decode-status': 'Native token evaluation returned an unsuccessful status.',
  'invalid-token-piece': 'Native token rendering returned an invalid buffer length.',
} satisfies Record<NonNullable<z.infer<typeof diagnosticSchema>['reason']>, string>;

export type Diagnostic = z.infer<typeof diagnosticSchema>;
const listeners = new Set<{ listener: ({ diagnostic }: { diagnostic: Diagnostic }) => void | Promise<void>, debug: 'off' | 'on', pending: Set<Promise<void>> }>();
/** A worker request owns the detail preference, independently of resident runtime callbacks. */
export function subscribeDiagnostics({ listener, debug }: { listener: ({ diagnostic }: { diagnostic: Diagnostic }) => void | Promise<void>, debug: 'off' | 'on' }): () => void {
  const subscription = { listener, debug, pending: new Set<Promise<void>>() };
  listeners.add(subscription);
  return () => {
    listeners.delete(subscription);
  };
}

/** Allowlisted fields only: never forward native logs, errors, names or chat data. */
export function logDiagnostic({ diagnostic }: { diagnostic: Diagnostic }): void {
  publishDiagnostic({ diagnostic, writeToConsole: true });
}
function publishDiagnostic({ diagnostic, writeToConsole }: { diagnostic: Diagnostic, writeToConsole: boolean }): void {
  const safe = diagnosticSchema.safeParse(diagnostic);
  if (!safe.success) return;
  for (const subscription of listeners) {
    try {
      const pending = Promise.resolve(subscription.listener({ diagnostic: { ...safe.data } })).catch(() => {});
      subscription.pending.add(pending);
      void pending.then(() => subscription.pending.delete(pending));
    } catch { /* Diagnostics must not interrupt inference. */ }
  }
  if (!writeToConsole) return;
  switch (safe.data.event) {
  case 'failed': {
    const { stage, failureKind, reason } = safe.data;
    // Descriptions come only from local closed dictionaries, never from the caller.
    const message = [
      stage ? `Failed while ${stageDescriptions[stage]}.` : 'The runtime operation failed.',
      failureKind ? failureDescriptions[failureKind] : undefined,
      reason ? reasonDescriptions[reason] : undefined,
      safe.data.lastStage ? `Last observed native stage: ${safe.data.lastStage} (${safe.data.lastEvent ?? 'unknown'}).` : undefined,
    ].filter(value => value !== undefined).join(' ');
    console.debug(`[llama-cpp-browser] ${JSON.stringify({ ...safe.data, message })}`);
    return;
  }
  case 'operation-start': case 'operation-complete': case 'operation-waiting': case 'native-error': case 'native-info': case 'native-node-start': case 'native-node-complete':
  case 'import-start': case 'import-complete': case 'runtime-ready': case 'load-complete':
  case 'load-start': case 'model-reused': case 'context-start': case 'context-ready':
  case 'prefill-start': case 'prefill-complete': case 'generation-start': case 'sampler-ready':
  case 'context-retry': case 'cache-reuse':
  case 'first-token-sampled': case 'generation-complete': case 'cancelled': case 'released':
    console.debug(`[llama-cpp-browser] ${JSON.stringify(safe.data)}`); return;
  default: { const exhaustive: never = safe.data.event; throw new Error(`Unknown diagnostic event: ${exhaustive}`); }
  }
}
/** Synchronous native callbacks cannot await host replies; the owning request drains them. */
export function logNativeCheckpoint({ diagnostic }: { diagnostic: Diagnostic }): void {
  publishDiagnostic({ diagnostic, writeToConsole: Array.from(listeners.values()).some(({ debug }) => debug === 'on') });
}
/** Await host acknowledgements before entering a native call that may never return. */
export async function logOperation({ diagnostic }: { diagnostic: Diagnostic }): Promise<void> {
  logNativeCheckpoint({ diagnostic });
  await Promise.all(Array.from(listeners.values()).flatMap(({ pending }) => Array.from(pending)));
}
/** Extract numbers only from the fixed WebGPU dispatch-limit diagnostic format. */
export function dispatchLimitDetails({ message }: { message: unknown }): { dispatchAxis: 'x' | 'y' | 'z', dispatchCount: number, dispatchLimit: number } | undefined {
  if (typeof message !== 'string') return undefined;
  const match = /\bDispatch workgroup count ([XYZ]) \((\d+)\) exceeds max compute workgroups per dimension \((\d+)\)\./i.exec(message);
  if (!match) return undefined;
  const dispatchCount = Number(match[2]); const dispatchLimit = Number(match[3]);
  const dispatchAxis = z.enum(['x', 'y', 'z']).parse(match[1]!.toLowerCase());
  if (!Number.isSafeInteger(dispatchCount) || !Number.isSafeInteger(dispatchLimit) || dispatchLimit < 1 || dispatchCount <= dispatchLimit) return undefined;
  return { dispatchAxis, dispatchCount, dispatchLimit };
}
/** Match known technical failures without forwarding the native message itself. */
export function knownNativeFailure({ message }: { message: unknown }): z.infer<typeof failureKindSchema> | undefined {
  if (typeof message !== 'string') return undefined;
  if (/maxComputeWorkgroupsPerDimension|max compute workgroups per dimension/i.test(message) && /exceed|limit|greater/i.test(message)) return 'webgpu-dispatch-limit';
  if (/\bggml_webgpu:\s*Device lost!/i.test(message)) return 'webgpu-device-lost';
  if (/\bggml_webgpu:\s*Device error!/i.test(message)) return 'webgpu-device-error';
  if (/\b(?:WebGPU|GPUDevice)\b.*\b(?:device\s+)?lost\b|\bdevice\s+lost\b.*\bWebGPU\b/i.test(message)) return 'webgpu-device-lost';
  if (/\b(?:WebGPU|GPUValidationError)\b.*(?:validation|invalid)|\bvalidation\b.*\b(?:WebGPU|GPUCommandEncoder|GPUComputePassEncoder)\b/i.test(message)) return 'webgpu-validation';
  return undefined;
}
export function classifyFailure({ error }: { error: unknown }): z.infer<typeof failureKindSchema> {
  const known = knownNativeFailure({ message: error instanceof Error ? error.message : error });
  if (known) return known;
  if (error instanceof WebAssembly.RuntimeError) return 'wasm-trap';
  if (typeof error === 'number' || typeof error === 'bigint') return 'native-exception';
  if (error instanceof z.ZodError) return 'validation-error';
  if (error instanceof TypeError) return 'type-error';
  if (error instanceof RangeError) return 'range-error';
  if (error instanceof DOMException && error.name === 'AbortError') return 'abort-error';
  if (error instanceof Error && (error.name === 'BindingError' || error.name === 'UnboundTypeError')) return 'binding-error';
  if (error instanceof Error) return 'javascript-error';
  return 'unknown-exception';
}
/** Classify locally without serializing exception values, messages or stacks. */
export function logFailure({ stage, error }: { stage: DiagnosticStage, error: unknown }): void {
  logDiagnostic({ diagnostic: { event: 'failed', stage, failureKind: classifyFailure({ error }), code: errorCode({ error }) } });
}
/** Upstream mtmd-helper emits these exact lines with a fixed image/audio label. */
function nativeMediaDiagnostic({ message }: { message: unknown }): Diagnostic | undefined {
  if (typeof message !== 'string' || message.length > 256) return undefined;
  const line = message.replace(/\r?\n$/, '');
  const encoding = /^encoding (image|audio) slice\.\.\.$/.exec(line);
  if (encoding) return { event: 'operation-start', stage: 'media-encode', mediaType: z.enum(['image', 'audio']).parse(encoding[1]) };
  const encoded = /^(image|audio) slice encoded in (\d+) ms$/.exec(line);
  if (encoded) {
    const elapsedMs = Number(encoded[2]);
    if (!Number.isSafeInteger(elapsedMs)) return undefined;
    return { event: 'operation-complete', stage: 'media-encode', mediaType: z.enum(['image', 'audio']).parse(encoded[1]), elapsedMs };
  }
  const decoding = /^decoding (image|audio) batch (\d+)\/(\d+), n_tokens_batch = (\d+)$/.exec(line);
  const decoded = /^(image|audio) decoded \(batch (\d+)\/(\d+)\) in (\d+) ms$/.exec(line);
  const batch = decoding ?? decoded;
  if (!batch) return undefined;
  const batchIndex = Number(batch[2]); const batchCount = Number(batch[3]); const number = Number(batch[4]);
  if (![batchIndex, batchCount, number].every(Number.isSafeInteger) || batchIndex < 1 || batchCount < batchIndex || batchCount > 2147483647 || (decoding && (number < 1 || number > 2147483647))) return undefined;
  return { event: decoding ? 'operation-start' : 'operation-complete', stage: 'media-decode', mediaType: z.enum(['image', 'audio']).parse(batch[1]), batchIndex, batchCount,
    ...(decoding ? { batchTokens: number } : { elapsedMs: number }) };
}
/** Fixed numeric context, graph and buffer formats from upstream llama.cpp. */
function nativeInfoDiagnostic({ message }: { message: unknown }): Diagnostic | undefined {
  if (typeof message !== 'string' || message.length > 256) return undefined;
  const line = message.replace(/\r?\n$/, '');
  const context = /^llama_context: (n_ctx|n_ctx_seq|n_batch|n_ubatch|n_seq_max)[ \t]+= (\d+)$/.exec(line);
  if (context) {
    const nativeValue = Number(context[2]);
    if (!Number.isSafeInteger(nativeValue)) return undefined;
    return { event: 'native-info', nativeMetric: nativeMetricSchema.parse(context[1]), nativeValue };
  }
  const graph = /^sched_reserve: graph (nodes|splits)[ \t]+= (\d+)(?: \(with bs=(\d+)\), (\d+) \(with bs=1\))?$/.exec(line);
  if (graph) {
    const nativeValue = Number(graph[2]);
    const batchTokens = graph[3] === undefined ? undefined : Number(graph[3]);
    const nativeSingleTokenValue = graph[4] === undefined ? undefined : Number(graph[4]);
    if (!Number.isSafeInteger(nativeValue) || (batchTokens !== undefined && (!Number.isSafeInteger(batchTokens) || batchTokens < 1 || batchTokens > 2147483647)) || (nativeSingleTokenValue !== undefined && !Number.isSafeInteger(nativeSingleTokenValue))) return undefined;
    return { event: 'native-info', nativeMetric: nativeMetricSchema.parse(`graph_${graph[1]}`), nativeValue, ...(batchTokens === undefined ? {} : { batchTokens, nativeSingleTokenValue }) };
  }
  const buffer = /^(?:sched_reserve:[ \t]+(CPU|CPU_Mapped|WebGPU) compute|load_tensors:[ \t]+(CPU|CPU_Mapped|WebGPU) model) buffer size =[ \t]+(\d+\.\d{2}) MiB$/.exec(line);
  if (!buffer) return undefined;
  const nativeValue = Number(buffer[3]);
  if (!Number.isFinite(nativeValue) || nativeValue > Number.MAX_SAFE_INTEGER) return undefined;
  return { event: 'native-info', nativeMetric: buffer[1] ? 'compute_buffer_mib' : 'model_buffer_mib', nativeValue, nativeBackend: z.enum(['CPU', 'CPU_Mapped', 'WebGPU']).parse(buffer[1] ?? buffer[2]) };
}
/** Image internals expose dimensions and counts, never tensors or input text. */
function nativeImageDiagnostic({ message }: { message: unknown }): Diagnostic | undefined {
  if (typeof message !== 'string' || message.length > 256) return undefined;
  const line = message.replace(/\r?\n$/, '');
  const batch = /^mtmd_batch_encode_impl: encoding batch with (\d+) entries and total (\d+) tokens$/.exec(line);
  if (batch) return { event: 'native-info', stage: 'media-encode', nativeOperation: 'encode-batch', nativeEntries: Number(batch[1]), tokens: Number(batch[2]) };
  const copy = /^clip_encode: copying image (\d+)\/(\d+) to input buffer \(nx=(\d+), ny=(\d+)\)$/.exec(line);
  if (copy) {
    const batchIndex = Number(copy[1]); const batchCount = Number(copy[2]);
    if (batchIndex > batchCount) return undefined;
    return { event: 'native-info', stage: 'media-encode', nativeOperation: 'copy-image', batchIndex, batchCount, imageWidth: Number(copy[3]), imageHeight: Number(copy[4]) };
  }
  const shape = /^clip_encode: output embedding shape \[(\d+), (\d+), (\d+)\]$/.exec(line);
  if (shape) return { event: 'native-info', stage: 'media-encode', nativeOperation: 'output-embedding', nativeShape: [Number(shape[1]), Number(shape[2]), Number(shape[3])] };
  const preproc = /^add_media: preproc_out has (\d+) entries, grid_x = (-?\d+), grid_y = (-?\d+), has_overview = ([01])$/.exec(line);
  if (preproc) return { event: 'native-info', stage: 'image-tokenize', nativeOperation: 'preprocess-image', nativeEntries: Number(preproc[1]), nativeGridX: Number(preproc[2]), nativeGridY: Number(preproc[3]), nativeOverview: preproc[4] === '1' };
  return undefined;
}
/** Keep structured progress/metrics and known failures; never forward raw stderr. */
export function logNativeDiagnostic({ message }: { message: unknown }): void {
  if (typeof message === 'string' && message.length <= 256) {
    const line = message.replace(/\r?\n$/, '');
    const graph = /^clip_encode: ggml_backend_sched_graph_compute failed with error (-?\d+)$/.exec(line);
    if (graph) {
      logDiagnostic({ diagnostic: { event: 'native-error', stage: 'media-encode', failureKind: 'native-graph-error', statusCode: Number(graph[1]) } }); return;
    }
    const output = /^clip_encode: expected output (\d+) tokens, got (\d+)$/.exec(line);
    if (output) {
      logDiagnostic({ diagnostic: { event: 'native-error', stage: 'media-encode', failureKind: 'native-output-mismatch', expectedTokens: Number(output[1]), tokens: Number(output[2]) } }); return;
    }
  }
  const progress = nativeMediaDiagnostic({ message }) ?? nativeInfoDiagnostic({ message }) ?? nativeImageDiagnostic({ message });
  if (progress) {
    logNativeCheckpoint({ diagnostic: progress }); return;
  }
  const failureKind = knownNativeFailure({ message });
  if (failureKind) logDiagnostic({ diagnostic: { event: 'native-error', failureKind, ...dispatchLimitDetails({ message }) } });
}
export const TEST_ONLY = {
};
