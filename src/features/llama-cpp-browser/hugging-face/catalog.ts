import { z } from 'zod';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-directory';
import { repositoryFileSchema, repositorySchema, repositoryUrlPath, revisionSchema, type RepositoryFile } from './types';

export type ModelCandidate = { label: string, files: RepositoryFile[], size: number };
export type RepositoryCatalog = { repository: string, revision: string, models: ModelCandidate[], projectors: RepositoryFile[] };
export function parseRepository({ input }: { input: string }): string {
  let value = input.trim();
  if (value.startsWith('hf.co/')) value = `https://${value}`;
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (!['huggingface.co', 'hf.co'].includes(url.hostname) || url.port || url.search || url.hash || url.username || url.password) throw new Error('Invalid Hugging Face repository');
    value = url.pathname.replace(/^\/+|\/+$/g, '');
  }
  return repositorySchema.parse(value);
}
export function groupModelFiles({ files }: { files: RepositoryFile[] }): Pick<RepositoryCatalog, 'models' | 'projectors'> {
  const projectors: RepositoryFile[] = []; const groups = new Map<string, RepositoryFile[]>();
  for (const file of files) {
    if ((file.path.split('/').at(-1) ?? '').toLowerCase().includes('mmproj')) {
      projectors.push(file); continue;
    }
    const split = /^(.*)-\d{5}-of-(\d{5})(\.gguf)$/i.exec(file.path);
    const key = split ? `${split[1]}-of-${split[2]}${split[3]}` : file.path;
    const group = groups.get(key) ?? []; group.push(file); groups.set(key, group);
  }
  const models: ModelCandidate[] = [];
  for (const [label, group] of groups) {
    group.sort((a, b) => a.path.localeCompare(b.path));
    try {
      resolveModelFiles({ files: group });
    } catch {
      continue;
    }
    const size = group.reduce((sum, file) => sum + file.size, 0);
    if (Number.isSafeInteger(size)) models.push({ label, files: group, size });
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
export async function discoverRepository({ input, signal }: { input: string, signal: AbortSignal }): Promise<RepositoryCatalog> {
  const requested = parseRepository({ input }); const requestedPath = repositoryUrlPath({ repository: requested });
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
