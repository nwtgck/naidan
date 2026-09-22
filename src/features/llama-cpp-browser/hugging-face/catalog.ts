import { modelGroups } from './model-variants';
import { z } from 'zod';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-directory';
import { repositoryFileSchema, repositorySchema, repositoryUrlPath, revisionSchema, type RepositoryFile } from './types';

export type ModelCandidate = { label: string, files: RepositoryFile[], size: number };
export type RepositoryCatalog = { repository: string, revision: string, models: ModelCandidate[], projectors: RepositoryFile[] };
export function parseRepository({ input }: { input: string }): { repository: string, requestedVariant: string | undefined } {
  let value = input.trim();
  if (value.startsWith('hf.co/')) value = `https://${value}`;
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (!['huggingface.co', 'hf.co'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Invalid Hugging Face repository');
    // Any URL suffix deliberately points to main, regardless of path, query or fragment.
    value = url.pathname.replace(/^\/+/, '').split('/').slice(0, 2).map(part => decodeURIComponent(part)).join('/');
  }
  const separator = value.indexOf(':');
  const repository = repositorySchema.parse(separator < 0 ? value : value.slice(0, separator));
  const requestedVariant = separator < 0 ? undefined : z.string().min(1).regex(/^[^\p{Cc}]+$/u).parse(value.slice(separator + 1));
  return { repository, requestedVariant };
}
export function groupModelFiles({ files }: { files: RepositoryFile[] }): Pick<RepositoryCatalog, 'models' | 'projectors'> {
  const { models: groups, projectors } = modelGroups({ files });
  const models: ModelCandidate[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.path.localeCompare(b.path));
    try {
      resolveModelFiles({ files: group });
    } catch {
      continue;
    }
    const size = group.reduce((sum, file) => sum + file.size, 0);
    if (Number.isSafeInteger(size)) models.push({ label: group[0]!.path, files: group, size });
  }
  return { models: models.sort((a, b) => a.label.localeCompare(b.label)), projectors: projectors.sort((a, b) => a.path.localeCompare(b.path)) };
}
async function fetchJson({ url, signal }: { url: string, signal: AbortSignal }): Promise<{ value: unknown, headers: Headers }> {
  const response = await privacyFetchStream({ request: { url, signal } });
  if (response.status !== 200) {
    await response.body.cancel(); throw new Error(`Hugging Face metadata HTTP ${response.status}`);
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 16 * 1024 * 1024) throw new Error('Hugging Face metadata exceeds the size limit'); chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset); offset += chunk.length;
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)), headers: response.headers };
  } catch (error) {
    await reader.cancel().catch(() => {}); throw error;
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
  const { repository: requested } = parseRepository({ input }); const requestedPath = repositoryUrlPath({ repository: requested });
  const metadata = await fetchJson({ url: `https://huggingface.co/api/models/${requestedPath}/revision/main`, signal });
  const { sha: revision, id: repository } = z.object({ sha: revisionSchema, id: repositorySchema }).parse(metadata.value);
  const path = repositoryUrlPath({ repository });
  const prefix = `/api/models/${path}/tree/${revision}`;
  let next: string | undefined = `https://huggingface.co${prefix}?recursive=true&expand=false`; const visited = new Set<string>(); const files: RepositoryFile[] = [];
  while (next) {
    if (visited.has(next) || visited.size >= 1000) throw new Error('Invalid Hugging Face pagination'); visited.add(next);
    const page = await fetchJson({ url: next, signal });
    for (const entry of treeSchema.parse(page.value)) {
      switch (entry.type) {
      case 'directory': continue; case 'file': break; default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
      }
      if (!/\.gguf$/i.test(entry.path)) continue;
      files.push(repositoryFileSchema.parse({ path: entry.path, size: entry.size }));
    }
    const link = page.headers.get('link'); const match = link?.match(/<([^>]+)>;\s*rel="next"/);
    next = undefined;
    if (match) {
      const url = new URL(match[1]!, 'https://huggingface.co');
      if (url.origin !== 'https://huggingface.co' || url.pathname !== prefix || url.username || url.password) throw new Error('Invalid Hugging Face pagination URL');
      next = url.href;
    }
  }
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate Hugging Face file');
  return { repository, revision, ...groupModelFiles({ files }) };
}
export const TEST_ONLY = {
};
