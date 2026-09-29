import { z } from 'zod';

export const REPLAY_METADATA_FILE_BYTES = 32 * 1024 * 1024;
export const REPLAY_METADATA_TARGET_BYTES = 48 * 1024 * 1024;
export const REPLAY_METADATA_BATCH_BYTES = 160 * 1024 * 1024;
export const REPLAY_METADATA_PATHS = [
  'config.json', 'tokenizer_config.json', 'generation_config.json',
  'processor_config.json', 'preprocessor_config.json', 'special_tokens_map.json',
  'added_tokens.json', 'chat_template.json', 'chat_template.jinja', 'tokenizer.json',
] as const;

const pathSchema = z.enum(REPLAY_METADATA_PATHS);
const metadataObjectSchema = z.record(z.string(), z.unknown());
const outcomeSchema = z.enum(['collected', 'not-listed', 'local-missing', 'unverified-revision', 'access-unverified', 'budget-exceeded', 'timeout', 'http-failure', 'read-failure', 'invalid-content', 'privacy-excluded', 'size-mismatch']);
export const replayMetadataSummarySchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().regex(/^[\w.-]+\/[\w.-]+$/u).refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  revision: z.string().regex(/^[a-f0-9]{40}$/iu).optional(),
  status: z.enum(['collecting', 'complete', 'partial']),
  receivedBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().min(0).max(REPLAY_METADATA_TARGET_BYTES),
  budgetBytes: z.number().int().min(0).max(REPLAY_METADATA_TARGET_BYTES),
  files: z.array(z.object({
    path: pathSchema,
    status: outcomeSchema,
    source: z.enum(['local-exact', 'remote-exact', 'not-read']),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    httpStatus: z.number().int().optional(),
  }).strict()).max(REPLAY_METADATA_PATHS.length),
}).strict().superRefine((summary, context) => {
  const paths = new Set(summary.files.map(file => file.path));
  const collected = summary.files.filter(file => file.status === 'collected');
  const retained = collected.reduce((total, file) => total + file.byteLength, 0);
  if (paths.size !== summary.files.length || retained !== summary.retainedBytes
    || retained > summary.budgetBytes || retained > summary.receivedBytes
    || collected.some(file => file.byteLength > REPLAY_METADATA_FILE_BYTES || file.sha256 === undefined || file.source === 'not-read')) {
    context.addIssue({ code: 'custom', message: 'Replay metadata summary identity, retained bytes, or file budget is inconsistent' });
  }
});

export type InvestigationReplayMetadataSummary = z.infer<typeof replayMetadataSummarySchema>;
export interface InvestigationReplayMetadataSidecar { path: string, blob: Blob }
type ReplayMetadataAccess = 'public-request' | 'excluded-private-or-gated' | 'unverified';
const repositoryAccessSchema = z.object({ private: z.boolean(), gated: z.union([z.boolean(), z.string()]) }).passthrough();

export function classifyReplayMetadataAccess({ metadata }: { metadata: unknown }): ReplayMetadataAccess {
  const result = repositoryAccessSchema.safeParse(metadata);
  if (!result.success) return 'unverified';
  return result.data.private || result.data.gated !== false ? 'excluded-private-or-gated' : 'public-request';
}

export type InvestigationReplayMetadataSnapshot = {
  summary: InvestigationReplayMetadataSummary,
  sidecars: InvestigationReplayMetadataSidecar[],
};

class CollectionFailure extends Error {
  readonly status: Exclude<z.infer<typeof outcomeSchema>, 'collected'>;
  readonly httpStatus: number | undefined;
  constructor({ status, httpStatus }: { status: Exclude<z.infer<typeof outcomeSchema>, 'collected'>, httpStatus: number | undefined }) {
    super(status);
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

// Public model token IDs/vocabulary are not secrets. Only credential-shaped keys/values
// are excluded; no generic /token/ redaction is applied to replayable model JSON.
export function validateReplayMetadataContent({ path, bytes }: { path: string, bytes: Uint8Array }): void {
  pathSchema.parse(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CollectionFailure({ status: 'invalid-content', httpStatus: undefined });
  }
  const hasCredential = ({ value }: { value: string }): boolean => /\b(?:hf_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|https?:\/\/[^\s/]+:[^\s/]+@|[?&](?:access_token|api_key|token|signature)=/iu.test(value);
  if (path.endsWith('.jinja')) {
    if (hasCredential({ value: text })) throw new CollectionFailure({ status: 'privacy-excluded', httpStatus: undefined });
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CollectionFailure({ status: 'invalid-content', httpStatus: undefined });
  }
  const object = metadataObjectSchema.safeParse(value);
  if (!object.success) throw new CollectionFailure({ status: 'invalid-content', httpStatus: undefined });
  const pending: Array<{ value: unknown, location: string }> = [{ value: object.data, location: '' }];
  while (pending.length > 0) {
    const { value: item, location } = pending.pop()!;
    // Vocabulary keys and added-token content are model data, not credential fields.
    // Validate the narrow vocabulary shape before treating it as an opaque token domain.
    if ((path === 'tokenizer.json' && location === 'model.vocab') || (path === 'added_tokens.json' && location === '')) {
      const valid = Array.isArray(item)
        ? item.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'number')
        : item !== null && typeof item === 'object' && Object.values(item).every(id => typeof id === 'number' && Number.isSafeInteger(id));
      if (!valid) throw new CollectionFailure({ status: 'invalid-content', httpStatus: undefined });
      continue;
    }
    if (path === 'tokenizer.json' && location === 'model.merges') {
      if (!Array.isArray(item) || !item.every(entry => typeof entry === 'string' || (Array.isArray(entry) && entry.length === 2 && entry.every(token => typeof token === 'string')))) {
        throw new CollectionFailure({ status: 'invalid-content', httpStatus: undefined });
      }
      continue;
    }
    if (((path === 'tokenizer.json' && /^added_tokens\.\d+\.content$/u.test(location))
      || (path === 'tokenizer_config.json' && /^added_tokens_decoder\.\d+\.content$/u.test(location))) && typeof item === 'string') continue;
    if (typeof item === 'string' && hasCredential({ value: item })) throw new CollectionFailure({ status: 'privacy-excluded', httpStatus: undefined });
    if (item === null || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:authorization|proxy-authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/iu.test(key)) {
        throw new CollectionFailure({ status: 'privacy-excluded', httpStatus: undefined });
      }
      pending.push({ value: child, location: location.length === 0 ? key : `${location}.${key}` });
    }
  }
}

export async function replayMetadataSha256({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function collectReplayMetadata({ modelId, revision, files, budgetBytes, fileTimeoutMs, modelAccess, localRead, remoteFetch, onSnapshot }: {
  modelId: string,
  revision: string | undefined,
  files: readonly { path: string, size: number | undefined }[] | undefined,
  budgetBytes: number,
  fileTimeoutMs: number,
  modelAccess: ReplayMetadataAccess,
  localRead: ({ path, revision }: { path: string, revision: string }) => Promise<Blob | undefined>,
  remoteFetch: typeof fetch | undefined,
  onSnapshot: ({ snapshot }: { snapshot: InvestigationReplayMetadataSnapshot }) => void,
}): Promise<InvestigationReplayMetadataSnapshot> {
  const summary = replayMetadataSummarySchema.parse({ schemaVersion: 1, modelId, revision, status: 'collecting', receivedBytes: 0, retainedBytes: 0, budgetBytes, files: [] });
  z.number().int().positive().parse(fileTimeoutMs);
  const sidecars: InvestigationReplayMetadataSidecar[] = [];
  const publish = (): InvestigationReplayMetadataSnapshot => {
    const snapshot = { summary: structuredClone(summary), sidecars: [...sidecars] };
    onSnapshot({ snapshot });
    return snapshot;
  };
  publish();
  for (const path of REPLAY_METADATA_PATHS) {
    const file = files?.find(item => item.path === path);
    let source: InvestigationReplayMetadataSummary['files'][number]['source'] = 'not-read';
    let received = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const controller = new AbortController();
    const fail = ({ status, httpStatus }: { status: Exclude<z.infer<typeof outcomeSchema>, 'collected'>, httpStatus: number | undefined }): never => {
      throw new CollectionFailure({ status: status, httpStatus: httpStatus });
    };
    const cancel = (): void => {
      controller.abort();
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
    };
    try {
      switch (modelAccess) {
      case 'public-request':
        break;
      case 'excluded-private-or-gated':
        throw new CollectionFailure({ status: 'privacy-excluded', httpStatus: undefined });
      case 'unverified':
        throw new CollectionFailure({ status: 'access-unverified', httpStatus: undefined });
      default: {
        const _ex: never = modelAccess;
        throw new Error(`Unhandled model access: ${_ex}`);
      }
      }
      if (revision === undefined) fail({ status: 'unverified-revision', httpStatus: undefined });
      if (files !== undefined && file === undefined) fail({ status: 'not-listed', httpStatus: undefined });
      const remaining = Math.min(REPLAY_METADATA_FILE_BYTES, budgetBytes - summary.receivedBytes);
      if (remaining <= 0 || (file?.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > remaining))) {
        fail({ status: 'budget-exceeded', httpStatus: undefined });
      }
      const exactRevision = revision!;
      const operation = (async () => {
        const local = await localRead({ path, revision: exactRevision });
        if (stopped) throw new CollectionFailure({ status: 'timeout', httpStatus: undefined });
        let stream: ReadableStream<Uint8Array>;
        let expectedSize: number | undefined = file?.size;
        if (local !== undefined) {
          source = 'local-exact';
          if (local.size > remaining) throw new CollectionFailure({ status: 'budget-exceeded', httpStatus: undefined });
          if (expectedSize !== undefined && local.size !== expectedSize) throw new CollectionFailure({ status: 'size-mismatch', httpStatus: undefined });
          expectedSize = local.size;
          stream = local.stream();
        } else {
          if (remoteFetch === undefined) throw new CollectionFailure({ status: 'local-missing', httpStatus: undefined });
          source = 'remote-exact';
          const response = await remoteFetch(`https://huggingface.co/${modelId}/resolve/${exactRevision}/${path}`, {
            credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
            headers: { Accept: path.endsWith('.json') ? 'application/json' : 'text/plain' },
          });
          if (stopped) {
            void response.body?.cancel().catch(() => undefined); throw new CollectionFailure({ status: 'timeout', httpStatus: undefined });
          }
          // These are full replay resources, not size probes. Even a response
          // labelled 200 must not archive a Content-Range fragment as complete.
          if (response.status !== 200 || response.headers.has('Content-Range')) {
            void response.body?.cancel().catch(() => undefined); throw new CollectionFailure({ status: 'http-failure', httpStatus: response.status });
          }
          const length = response.headers.get('content-length');
          if (length !== null && (!/^\d+$/u.test(length) || Number(length) > remaining)) {
            void response.body?.cancel().catch(() => undefined);
            throw new CollectionFailure({ status: 'budget-exceeded', httpStatus: undefined });
          }
          if (response.body === null) throw new CollectionFailure({ status: 'read-failure', httpStatus: undefined });
          stream = response.body;
        }
        reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const next = await reader.read();
          if (stopped) throw new CollectionFailure({ status: 'timeout', httpStatus: undefined });
          if (next.done) break;
          received += next.value.byteLength;
          summary.receivedBytes += next.value.byteLength;
          if (received > remaining) throw new CollectionFailure({ status: 'budget-exceeded', httpStatus: undefined });
          chunks.push(next.value);
        }
        if (expectedSize !== undefined && received !== expectedSize) throw new CollectionFailure({ status: 'size-mismatch', httpStatus: undefined });
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset); offset += chunk.byteLength;
        }
        validateReplayMetadataContent({ path, bytes });
        const sha256 = await replayMetadataSha256({ bytes });
        if (stopped) throw new CollectionFailure({ status: 'timeout', httpStatus: undefined });
        return { blob: new Blob([bytes]), sha256 };
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stopped = true; cancel(); reject(new CollectionFailure({ status: 'timeout', httpStatus: undefined }));
        }, fileTimeoutMs);
      });
      const result = await Promise.race([operation, timeout]);
      sidecars.push({ path, blob: result.blob });
      summary.retainedBytes += result.blob.size;
      summary.files.push({ path, status: 'collected', source, byteLength: received, sha256: result.sha256 });
    } catch (error) {
      stopped = true;
      cancel();
      summary.files.push({ path, status: error instanceof CollectionFailure ? error.status : 'read-failure', source, byteLength: received, httpStatus: error instanceof CollectionFailure ? error.httpStatus : undefined });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    publish();
  }
  summary.status = summary.files.every(file => file.status === 'collected' || file.status === 'not-listed') ? 'complete' : 'partial';
  return publish();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
