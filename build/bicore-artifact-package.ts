import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const runtimeDirectories = {
  'llama-cpp': 'runtimes/llama-cpp-browser-core/',
  'stable-diffusion-cpp': 'runtimes/stable-diffusion-cpp-browser-core/',
  'speech-cpp': 'runtimes/speech-cpp-browser-core/',
} as const;
type Runtime = keyof typeof runtimeDirectories;

export const bicoreFileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative().refine(Number.isSafeInteger),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const sourceCommit = z.string().regex(/^[0-9a-f]{40}$/);
const existingRuntimeBindings = {
  'llama-cpp': z.object({ manifest: z.literal('runtimes/llama-cpp-browser-core/manifest.json'), manifestFormatVersion: z.literal(2) }),
  'stable-diffusion-cpp': z.object({ manifest: z.literal('runtimes/stable-diffusion-cpp-browser-core/manifest.json'), manifestFormatVersion: z.literal(2) }),
};
const rootManifestSchema = z.discriminatedUnion('formatVersion', [z.object({
  formatVersion: z.literal(5),
  sourceCommit,
  runtimes: z.object(existingRuntimeBindings),
  files: z.array(bicoreFileSchema),
}), z.object({
  formatVersion: z.literal(6),
  sourceCommit,
  runtimes: z.object({
    ...existingRuntimeBindings,
    'speech-cpp': z.object({ manifest: z.literal('runtimes/speech-cpp-browser-core/manifest.json'), manifestFormatVersion: z.literal(2) }),
  }),
  files: z.array(bicoreFileSchema),
})]);
const runtimeManifestSchema = z.object({
  formatVersion: z.literal(2),
  runtime: z.string().optional(),
  sourceCommit,
  files: z.array(bicoreFileSchema),
});

function assertRelativePath({ relative }: { relative: string }): void {
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe bicore artifact path: ${relative}`);
  }
}

function inventory({ entries }: { entries: z.infer<typeof bicoreFileSchema>[] }) {
  const files = new Map<string, z.infer<typeof bicoreFileSchema>>();
  for (const entry of entries) {
    assertRelativePath({ relative: entry.path });
    if (files.has(entry.path)) {
      throw new Error(`Duplicate bicore manifest entry: ${entry.path}`);
    }
    files.set(entry.path, entry);
  }
  return files;
}

/** Verify the selected runtime's complete inventory without opening its payloads.
 * Payload integrity is checked on demand, preserving lazy Wasm loading and the
 * standalone boundary. Another runtime is never read as a side effect.
 */
export function readBicoreArtifactPackage({ directory, runtime, maxFileBytes }: {
  directory: string, runtime: Runtime, maxFileBytes: number | undefined,
}) {
  const packageRoot = realpathSync(directory);
  const prefix = runtimeDirectories[runtime];
  function readFile({ relative, expectedBytes }: { relative: string, expectedBytes: number | undefined }) {
    assertRelativePath({ relative });
    const filePath = realpathSync(path.join(packageRoot, relative));
    if (!filePath.startsWith(packageRoot + path.sep)) {
      throw new Error(`Bicore artifact escapes package: ${relative}`);
    }
    const status = statSync(filePath);
    if (!status.isFile() || (expectedBytes !== undefined && status.size !== expectedBytes)) {
      throw new Error(`Bicore artifact integrity mismatch (size mismatch): ${relative}`);
    }
    if (maxFileBytes !== undefined && status.size >= maxFileBytes) {
      throw new Error(`Oversized bicore artifact: ${relative}`);
    }
    return { filePath, data: readFileSync(filePath) };
  }
  const rootManifestPath = path.join(packageRoot, 'manifest.json');
  const root = rootManifestSchema.parse(JSON.parse(readFile({ relative: 'manifest.json', expectedBytes: undefined }).data.toString('utf8')));
  const rootFiles = inventory({ entries: root.files });
  function readRootFile({ relative }: { relative: string }) {
    const entry = rootFiles.get(relative);
    if (!entry) {
      throw new Error(`Missing bicore artifact: ${relative}`);
    }
    const result = readFile({ relative, expectedBytes: entry.bytes });
    if (result.data.length !== entry.bytes || createHash('sha256').update(result.data).digest('hex') !== entry.sha256) {
      throw new Error(`Bicore artifact integrity mismatch: ${relative}`);
    }
    return { ...result, bytes: entry.bytes, sha256: entry.sha256 };
  }
  const binding = (() => {
    switch (runtime) {
    case 'llama-cpp':
    case 'stable-diffusion-cpp': return root.runtimes[runtime];
    case 'speech-cpp':
      switch (root.formatVersion) {
      case 5: return undefined;
      case 6: return root.runtimes['speech-cpp'];
      default: {
        const exhaustive: never = root;
        throw new Error(`Unknown bicore root: ${exhaustive}`);
      }
      }
    default: {
      const exhaustive: never = runtime;
      throw new Error(`Unknown bicore runtime: ${exhaustive}`);
    }
    }
  })();
  if (binding === undefined) {
    throw new Error(`Bicore artifact does not include runtime: ${runtime}`);
  }
  const manifestRelative = binding.manifest;
  const manifest: unknown = JSON.parse(readRootFile({ relative: manifestRelative }).data.toString('utf8'));
  const parsed = runtimeManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error('Unsupported bicore runtime manifest; expected format 2', { cause: parsed.error });
  }
  const inner = parsed.data;
  if (inner.sourceCommit !== root.sourceCommit) {
    throw new Error('Mixed runtime source commits');
  }
  if (inner.runtime !== undefined && inner.runtime !== runtime) {
    throw new Error('Bicore manifest belongs to another runtime');
  }
  const files = inventory({ entries: inner.files });
  for (const entry of files.values()) {
    if (entry.path === 'manifest.json') {
      throw new Error('Runtime inventory cannot contain its own manifest');
    }
  }
  for (const relative of rootFiles.keys()) {
    if (relative === 'manifest.json' || (relative.startsWith('runtimes/') && !Object.values(root.runtimes).some(binding => binding.manifest === relative))) {
      throw new Error(`Bicore root inventory contains a runtime payload or its own manifest: ${relative}`);
    }
  }
  function readArtifact({ relative }: { relative: string }) {
    assertRelativePath({ relative });
    const entry = files.get(relative);
    if (!entry) {
      throw new Error(`Missing runtime artifact: ${relative}`);
    }
    const result = readFile({ relative: prefix + relative, expectedBytes: entry.bytes });
    if (result.data.length !== entry.bytes || createHash('sha256').update(result.data).digest('hex') !== entry.sha256) {
      throw new Error(`Bicore artifact integrity mismatch: ${relative}`);
    }
    return { ...result, bytes: entry.bytes, sha256: entry.sha256 };
  }
  return {
    packageRoot,
    runtimeRoot: path.join(packageRoot, prefix),
    sourceCommit: root.sourceCommit,
    rootMetadata: { formatVersion: root.formatVersion, sourceCommit: root.sourceCommit },
    runtimeMetadata: inner,
    manifestPaths: [rootManifestPath, path.join(packageRoot, manifestRelative)],
    manifest,
    files,
    readArtifact,
  };
}

export const TEST_ONLY = {
};
