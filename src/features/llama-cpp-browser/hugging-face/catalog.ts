import { modelGroups } from './model-variants';
import { z } from 'zod';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { validatePrivacyFetchUrl } from '@/features/privacy-fetch/validate-url';
import { normalizeHuggingFaceParameterFilter } from '@/features/privacy-fetch/policies/huggingface';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-directory';
import { repositoryFileSchema, repositorySchema, repositoryUrlPath, revisionSchema, type RepositoryFile } from './types';

export type ModelCandidate = { label: string, files: RepositoryFile[], size: number };
export type RepositoryCatalog = { repository: string, revision: string, models: ModelCandidate[], projectors: RepositoryFile[] };

// Validate only fields rendered by repository search. Other API fields may
// evolve without changing this workflow.
const optionalSearchCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined);
const optionalSearchTotalSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined);
const optionalSearchTextSchema = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}]+$/u).optional().catch(undefined);
const modelSearchResultSchema = z.object({
  id: repositorySchema,
  downloads: optionalSearchCountSchema,
  likes: optionalSearchCountSchema,
  pipeline_tag: optionalSearchTextSchema,
  gguf: z.object({ total: optionalSearchTotalSchema, architecture: optionalSearchTextSchema }).optional().catch(undefined),
  safetensors: z.object({ total: optionalSearchTotalSchema }).optional().catch(undefined),
  lastModified: z.iso.datetime({ offset: true }).optional().catch(undefined),
});
export type ModelSearchResult = z.infer<typeof modelSearchResultSchema>;
export type ModelSearchPage = { results: ModelSearchResult[], nextCursor: string | undefined };
const searchExpandedFields = ['pipeline_tag', 'gguf', 'safetensors', 'downloads', 'likes', 'lastModified'];
const searchCursorSchema = z.string().min(1).max(8192).regex(/^[^\p{Cc}]+$/u);

export function createSearchParameterFilter({ minimumBillions, maximumBillions }: { minimumBillions: string, maximumBillions: string }): string | undefined {
  if ([minimumBillions, maximumBillions].some(value => value.trim() && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
    throw new Error('Invalid parameter range');
  }
  const minimum = minimumBillions.trim().replace(/^\./, '0.').replace(/\.$/, '');
  const maximum = maximumBillions.trim().replace(/^\./, '0.').replace(/\.$/, '');
  if (!minimum && !maximum) {
    return undefined;
  }
  const raw = [minimum ? `min:${minimum}B` : undefined, maximum ? `max:${maximum}B` : undefined].filter(bound => bound !== undefined).join(',');
  const normalized = normalizeHuggingFaceParameterFilter({ value: raw });
  if (normalized === undefined) {
    throw new Error('Invalid parameter range');
  }
  return normalized;
}

function searchUrl({ query, cursor, numParameters }: { query: string, cursor: string | undefined, numParameters: string | undefined }): URL {
  const url = new URL('https://huggingface.co/api/models');
  url.searchParams.set('apps', 'llama.cpp');
  url.searchParams.set('sort', 'trendingScore');
  if (query) {
    url.searchParams.set('search', query);
  }
  url.searchParams.set('limit', '20');
  for (const field of searchExpandedFields) {
    url.searchParams.append('expand[]', field);
  }
  if (cursor !== undefined) {
    url.searchParams.set('cursor', searchCursorSchema.parse(cursor));
  }
  if (numParameters !== undefined) {
    const normalized = normalizeHuggingFaceParameterFilter({ value: numParameters });
    if (normalized === undefined) {
      throw new Error('Invalid parameter range');
    }
    url.searchParams.set('num_parameters', normalized);
  }
  return url;
}

function nextSearchCursor({ link, requestUrl, cursor }: { link: string | undefined, requestUrl: URL, cursor: string | undefined }): string | undefined {
  const nextLinks = (link ?? '').split(/,(?=\s*<)/).flatMap(part => {
    const target = part.match(/^\s*<([^>]+)>\s*;\s*(.*)$/);
    const relation = target?.[2]?.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    return target && relation && (relation[1] ?? relation[2] ?? '').toLowerCase().split(/\s+/).includes('next') ? [target[1]!] : [];
  });
  if (nextLinks.length !== 1) {
    return undefined;
  }
  try {
    const next = new URL(nextLinks[0]!, requestUrl);
    if (next.origin !== requestUrl.origin || next.pathname !== '/api/models' || next.username || next.password || next.hash) {
      return undefined;
    }
    // Accept either documented array spelling in Link headers, then rebuild
    // our own request URL from the cursor instead of fetching the supplied URL.
    const expanded = [...next.searchParams.getAll('expand[]'), ...next.searchParams.getAll('expand')];
    if (new Set(expanded).size !== expanded.length || expanded.some(field => !searchExpandedFields.includes(field))) {
      return undefined;
    }
    next.searchParams.delete('expand');
    next.searchParams.delete('expand[]');
    for (const field of expanded) {
      next.searchParams.append('expand[]', field);
    }
    if (next.searchParams.has('num_parameters')) {
      const normalized = normalizeHuggingFaceParameterFilter({ value: next.searchParams.get('num_parameters')! });
      if (next.searchParams.getAll('num_parameters').length !== 1 || normalized === undefined || normalized !== requestUrl.searchParams.get('num_parameters')) {
        return undefined;
      }
      next.searchParams.set('num_parameters', normalized);
    }
    for (const key of ['apps', 'sort', 'limit', 'search', 'num_parameters']) {
      if (next.searchParams.has(key) && (next.searchParams.get(key) ?? '') !== (requestUrl.searchParams.get(key) ?? '')) {
        return undefined;
      }
      const original = requestUrl.searchParams.get(key);
      if (!next.searchParams.has(key) && original !== null) {
        next.searchParams.set(key, original);
      }
    }
    if (!validatePrivacyFetchUrl({ urlText: next.href }).ok) {
      return undefined;
    }
    const candidate = searchCursorSchema.safeParse(next.searchParams.get('cursor'));
    return candidate.success && candidate.data !== cursor ? candidate.data : undefined;
  } catch {
    return undefined;
  }
}

// Calling this function requires an explicit search or trending-list request.
export async function searchModels({ query, cursor, numParameters, signal }: { query: string, cursor: string | undefined, numParameters: string | undefined, signal: AbortSignal }): Promise<ModelSearchPage> {
  const search = z.string().max(200).regex(/^[^\p{Cc}]*$/u).parse(query.trim());
  signal.throwIfAborted();
  const url = searchUrl({ query: search, cursor, numParameters });
  const response = await fetchJson({ url: url.href, signal });
  signal.throwIfAborted();
  const results = z.array(modelSearchResultSchema).parse(response.value);
  return { results: [...new Map(results.map(result => [result.id, result])).values()].slice(0, 20), nextCursor: nextSearchCursor({ link: response.headers.get('link') ?? undefined, requestUrl: url, cursor }) };
}

export function parseRepository({ input }: { input: string }): { repository: string, requestedVariant: string | undefined } {
  let value = input.trim();
  if (value.startsWith('hf.co/')) {
    value = `https://${value}`;
  }
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (!['huggingface.co', 'hf.co'].includes(url.hostname) || url.port || url.username || url.password) {
      throw new Error('Invalid Hugging Face repository');
    }
    // Any URL suffix deliberately points to main, regardless of path, query or fragment.
    value = url.pathname.replace(/^\/+/, '').split('/').slice(0, 2).map(part => decodeURIComponent(part)).join('/');
  }
  const separator = value.indexOf(':');
  const repository = repositorySchema.parse(separator < 0 ? value : value.slice(0, separator));
  const requestedVariant = separator < 0 ? undefined : z.string().min(1).regex(/^[^\p{Cc}]+$/u).parse(value.slice(separator + 1));
  return { repository, requestedVariant };
}

export function groupModelFiles({ files }: { files: RepositoryFile[] }): Pick<RepositoryCatalog, 'models' | 'projectors'> {
  const { models: groups, projectors } = modelGroups({ files: files.map(file => ({ relativePath: file.path, source: file })) });
  const models: ModelCandidate[] = [];
  for (const entries of groups) {
    const group = entries.map(entry => entry.source);
    group.sort((a, b) => a.path.localeCompare(b.path));
    try {
      resolveModelFiles({ files: group.map(file => ({ relativePath: file.path })) });
    } catch {
      continue;
    }
    const size = group.reduce((sum, file) => sum + file.size, 0);
    if (Number.isSafeInteger(size)) {
      models.push({ label: group[0]!.path, files: group, size });
    }
  }
  return { models: models.sort((a, b) => a.label.localeCompare(b.label)), projectors: projectors.map(entry => entry.source).sort((a, b) => a.path.localeCompare(b.path)) };
}

async function fetchJson({ url, signal }: { url: string, signal: AbortSignal }): Promise<{ value: unknown, headers: Headers }> {
  const response = await privacyFetchStream({ request: { url, signal } });
  if (response.status !== 200) {
    await response.body.cancel();
    throw new Error(`Hugging Face metadata HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 16 * 1024 * 1024) {
        throw new Error('Hugging Face metadata exceeds the size limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)), headers: response.headers };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const treeSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string(), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal('directory'), path: z.string() }),
]));

// Privacy boundary: callers must have an explicit user preview/download request.
// The llama-cpp-browser-model query is an explicit request to inspect that model.
// Mount, focus, details expansion and bundled-catalog filters are NOT permission.
export async function discoverRepository({ input, signal }: { input: string, signal: AbortSignal }): Promise<RepositoryCatalog> {
  const { repository: requested } = parseRepository({ input });
  const requestedPath = repositoryUrlPath({ repository: requested });
  const metadata = await fetchJson({ url: `https://huggingface.co/api/models/${requestedPath}/revision/main`, signal });
  const { sha: revision, id: repository } = z.object({ sha: revisionSchema, id: repositorySchema }).parse(metadata.value);
  const path = repositoryUrlPath({ repository });
  const prefix = `/api/models/${path}/tree/${revision}`;
  let next: string | undefined = `https://huggingface.co${prefix}?recursive=true&expand=false`;
  const visited = new Set<string>();
  const files: RepositoryFile[] = [];
  while (next) {
    if (visited.has(next) || visited.size >= 1000) {
      throw new Error('Invalid Hugging Face pagination');
    }
    visited.add(next);
    const page = await fetchJson({ url: next, signal });
    for (const entry of treeSchema.parse(page.value)) {
      switch (entry.type) {
      case 'directory': continue;
      case 'file': break;
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
      if (!/\.gguf$/i.test(entry.path)) {
        continue;
      }
      files.push(repositoryFileSchema.parse({ path: entry.path, size: entry.size }));
    }
    const link = page.headers.get('link');
    const match = link?.match(/<([^>]+)>;\s*rel="next"/);
    next = undefined;
    if (match) {
      const url = new URL(match[1]!, 'https://huggingface.co');
      if (url.origin !== 'https://huggingface.co' || url.pathname !== prefix || url.username || url.password) {
        throw new Error('Invalid Hugging Face pagination URL');
      }
      next = url.href;
    }
  }
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error('Duplicate Hugging Face file');
  }
  return { repository, revision, ...groupModelFiles({ files }) };
}

export const TEST_ONLY = {
};
