import { Secret } from '@/utils/secret';
import type { WorkflowModelConfiguration } from '@/01-models/workflow';
import { idToRaw } from '@/01-models/ids';
import { cloneEndpoint, isConfiguredEndpoint } from '@/01-models/endpoint';
import { isDefinitionWorkflowTarget, type WorkflowValueSource } from './provenance';

type Target = Pick<WorkflowModelConfiguration, 'endpoint' | 'modelId'>;
export type WorkflowConnectionReview = {
  endpoint: string, modelId: string, headerNames: string[], scope: 'editing_session' | 'run', sources: readonly WorkflowValueSource[],
};
type RequestApproval = ({ review, signal }: { review: WorkflowConnectionReview, signal: AbortSignal }) => Promise<boolean>;
const MAX_REVIEWED_TARGETS = 128;
const MAX_IDENTITY_LENGTH = 16384;

function identity({ target }: { target: Target }): Secret<string> {
  if (!target.modelId.trim() || !isConfiguredEndpoint({ endpoint: target.endpoint })) {
    throw new Error('A configured model connection is required.');
  }
  const endpoint = cloneEndpoint({ endpoint: target.endpoint });
  if (endpoint.type === 'ollama' || endpoint.type === 'openai') {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      throw new Error('The model connection needs an absolute HTTP or HTTPS address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('The model connection needs an absolute HTTP or HTTPS address.');
    }
  }
  // Exact headers and registration identity matter. Do not use model namespaces,
  // host-only comparisons or model parameters as permission identities.
  return Secret.from({
    value: JSON.stringify({
      endpoint: endpoint.type === 'ollama' || endpoint.type === 'openai'
        ? { ...endpoint, httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value.reveal()]) }
        : endpoint,
      modelId: target.modelId,
    }),
  });
}

function includesKey({ entries, key }: { entries: readonly Secret<string>[], key: Secret<string> }): boolean {
  return entries.some(item => Secret.equals(item, key));
}

function remember({ entries, key }: { entries: Secret<string>[], key: Secret<string> }): void {
  // This authorization identity contains credentials: keep it wrapped and
  // bounded, never persisted or included in a diagnostic payload.
  if (key.reveal().length > MAX_IDENTITY_LENGTH || includesKey({ entries, key })) {
    return;
  }
  if (entries.length >= MAX_REVIEWED_TARGETS) {
    entries.shift();
  }
  entries.push(key);
}

export function describeWorkflowConnection({ target, scope, sources }: { target: Target, scope: WorkflowConnectionReview['scope'], sources: readonly WorkflowValueSource[] }): WorkflowConnectionReview {
  const endpoint = target.endpoint;
  const evidence: readonly WorkflowValueSource[] = sources.length ? [...new Set(sources)] : ['unknown'];
  switch (endpoint.type) {
  case 'openai': case 'ollama': {
    // Do not put user info, query values, fragments or header values in a prompt.
    const url = new URL(endpoint.url);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...new Set(url.searchParams.keys())]) {
      url.searchParams.set(key, '[redacted]');
    }
    return { endpoint: `${endpoint.type} · ${url.href}`, modelId: target.modelId, headerNames: endpoint.httpHeaders?.map(([name]) => name) ?? [], scope, sources: evidence };
  }
  case 'naidan_rpc': return { endpoint: `${endpoint.type} · ${endpoint.registrationId === undefined ? '' : idToRaw({ id: endpoint.registrationId })}`, modelId: target.modelId, headerNames: [], scope, sources: evidence };
  case 'transformers_js': case 'llama_cpp_browser': case 'browser_provided_lm': return { endpoint: endpoint.type, modelId: target.modelId, headerNames: [], scope, sources: evidence };
  case 'unsupported_experimental_endpoint': throw new Error('Unsupported model connection.');
  default: {
    const exhaustive: never = endpoint;
    throw new Error(`Unknown endpoint: ${String(exhaustive)}`);
  }
  }
}

/** Reviews are local UI authority, never a field imported from Workflow JSON.
 * Each run takes a snapshot: editing during a run cannot silently authorize it.
 */
export function createWorkflowModelPermissions() {
  return createWorkflowTargetPermissions<Target>({ targetIdentity: identity, describe: describeWorkflowConnection });
}

/** Effect-specific factories share lifecycle rules, never their authority sets. */
export function createWorkflowTargetPermissions<T>({ targetIdentity, describe }: {
  targetIdentity: ({ target }: { target: T }) => Secret<string>,
  describe: ({ target, scope, sources }: { target: T, scope: WorkflowConnectionReview['scope'], sources: readonly WorkflowValueSource[] }) => WorkflowConnectionReview,
}) {
  const reviewed: Secret<string>[] = [];
  let epoch = 0;
  function reset(): void {
    epoch++;
    reviewed.length = 0;
  }
  function review({ target }: { target: T }): void {
    try {
      remember({ entries: reviewed, key: targetIdentity({ target }) });
    } catch {
      // Incomplete form edits do not grant anything; validation remains visible
      // in the editor and authorization checks again before any provider loads.
    }
  }
  function beginRun() {
    const started = epoch;
    const fixed = [...reviewed];
    const dynamic: Secret<string>[] = [];
    let requesting = false;
    async function authorize({ target, sources, signal, request }: {
      target: T, sources: readonly WorkflowValueSource[], signal: AbortSignal, request: RequestApproval,
    }): Promise<void> {
      signal.throwIfAborted();
      const key = targetIdentity({ target });
      const fromDefinition = isDefinitionWorkflowTarget({ sources });
      const entries = fromDefinition ? fixed : dynamic;
      if (includesKey({ entries, key })) {
        return;
      }
      if (requesting) {
        throw new Error('Another Workflow connection review is active.');
      }
      requesting = true;
      try {
        const allowed = await request({ review: describe({ target, scope: fromDefinition ? 'editing_session' : 'run', sources }), signal });
        signal.throwIfAborted();
        if (!allowed) {
          throw new Error('Model connection was denied.');
        }
        if (!Secret.equals(targetIdentity({ target }), key)) {
          throw new Error('The model connection changed during review.');
        }
        remember({ entries, key });
        // A delayed review cannot confer authority on a different open document.
        if (fromDefinition && epoch === started) {
          remember({ entries: reviewed, key });
        }
      } finally {
        requesting = false;
      }
    }
    return { authorize };
  }
  return { review, reset, beginRun };
}

export const TEST_ONLY = {
  MAX_REVIEWED_TARGETS,
  MAX_IDENTITY_LENGTH,
};
