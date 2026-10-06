import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const fileSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative().refine(Number.isSafeInteger), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const sourceCommit = z.string().regex(/^[0-9a-f]{40}$/);
// The combined artifact manifest and nested runtime manifest version independently.
const artifactManifestFormatVersion = 3;
const llamaManifestFormatVersion = 2;
const rootManifestSchema = z.object({
  formatVersion: z.literal(artifactManifestFormatVersion), sourceCommit,
  runtimes: z.object({ 'llama-cpp': z.object({ manifest: z.literal('llama-cpp-browser-core/manifest.json'), manifestFormatVersion: z.literal(llamaManifestFormatVersion) }) }),
  files: z.array(fileSchema),
});
const llamaManifestSchema = z.object({ formatVersion: z.literal(llamaManifestFormatVersion), sourceCommit, files: z.array(fileSchema) });
const innerPrefix = 'llama-cpp-browser-core/';

/** Read only the reviewed llama subtree from the combined bicore package. */
export function readLlamaArtifactPackage({ rootDir }: { rootDir: string }) {
  const packageRoot = realpathSync(path.join(rootDir, 'node_modules/llama-cpp-browser-core'));
  const rootManifestPath = path.join(packageRoot, 'manifest.json');
  const innerManifestPath = path.join(packageRoot, innerPrefix, 'manifest.json');
  const root = rootManifestSchema.parse(JSON.parse(readFileSync(rootManifestPath, 'utf8')));
  const rootFiles = new Map(root.files.map(file => [file.path, file]));
  if (rootFiles.size !== root.files.length) throw new Error('Duplicate bicore manifest entry');
  function readRootFile({ relative }: { relative: string }): { filePath: string, data: Buffer, bytes: number, sha256: string } {
    if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid core artifact path');
    const entry = rootFiles.get(relative);
    if (!entry) throw new Error(`Missing core artifact: ${relative}`);
    const filePath = realpathSync(path.join(packageRoot, relative));
    if (!filePath.startsWith(packageRoot + path.sep)) throw new Error('Core artifact escapes package');
    if (!statSync(filePath).isFile()) throw new Error(`Core artifact is not a file: ${relative}`);
    const data = readFileSync(filePath);
    if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`Core artifact integrity mismatch: ${relative}`);
    return { filePath, data, bytes: entry.bytes, sha256: entry.sha256 };
  }
  const inner = llamaManifestSchema.parse(JSON.parse(readRootFile({ relative: innerPrefix + 'manifest.json' }).data.toString('utf8')));
  if (inner.sourceCommit !== root.sourceCommit) throw new Error('Mixed llama runtime source commits');
  const files = new Map(inner.files.map(file => [file.path, file]));
  if (files.size !== inner.files.length) throw new Error('Duplicate llama manifest entry');
  function readArtifact({ relative }: { relative: string }) {
    const entry = files.get(relative);
    const parent = rootFiles.get(innerPrefix + relative);
    if (!entry || !parent || entry.bytes !== parent.bytes || entry.sha256 !== parent.sha256) throw new Error(`Llama inventory differs from bicore: ${relative}`);
    return readRootFile({ relative: innerPrefix + relative });
  }
  return { packageRoot, profileRoot: path.join(packageRoot, innerPrefix, 'profiles'), manifestPaths: [rootManifestPath, innerManifestPath], files, readArtifact };
}

export const TEST_ONLY = {
};
