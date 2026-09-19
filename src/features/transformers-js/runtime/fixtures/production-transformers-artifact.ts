import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants, SourceTextModule, SyntheticModule } from 'node:vm';
import { afterAll } from 'vitest';
import { buildTransformersJsFixesArtifact } from '../../../../../build/transformers-js-fixes/artifact';

// Share build mechanics, never an evaluated Transformers.js runtime instance.
let artifactPromise: ReturnType<typeof createArtifact> | undefined;
const ownedDirectories = new Set<string>();

async function createArtifact() {
  const artifact = await buildTransformersJsFixesArtifact({ projectRoot: process.cwd() });
  const directory = await mkdtemp(join(tmpdir(), 'naidan-transformers-js-fixes-'));
  ownedDirectories.add(directory);
  const modulePath = join(directory, 'transformers-js-fixes.mjs');
  // These are Vite's output bytes, with no test-only code transformation.
  await writeFile(modulePath, artifact.code);
  await writeFile(`${modulePath}.map`, artifact.map.toString());
  const saved = await readFile(modulePath);
  if (createHash('sha256').update(saved).digest('hex') !== artifact.artifactSha256) {
    throw new Error('Saved Transformers.js artifact differs from the production plugin build');
  }
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    originalBundleSha256: artifact.originalBundleSha256,
    transformedBundleSha256: artifact.transformedBundleSha256,
    artifactSha256: artifact.artifactSha256,
    ortWebGpuUrl: artifact.ortWebGpuUrl,
    ortCommonUrl: artifact.ortCommonUrl,
  };
}

export function getProductionTransformersArtifact() {
  artifactPromise ??= createArtifact();
  return artifactPromise;
}

// Only the two reviewed external ORT modules use Node's native import cache.
// Keep the same ESM Tensor and InferenceSession identities as the replay spies.
type NativeImport = ({ moduleUrl }: { moduleUrl: string }) => Promise<unknown>;
const nativeImport = compileFunction('return import(input.moduleUrl)', ['input'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as NativeImport;

async function evaluateArtifactModule({ code, moduleUrl, ortWebGpuUrl, ortCommonUrl }: {
  code: string,
  moduleUrl: string,
  ortWebGpuUrl: string,
  ortCommonUrl: string,
}): Promise<unknown> {
  // SourceTextModule evaluates the emitted bytes as ESM, not a test-only
  // rewrite. No registry retains this module: its namespace belongs to the
  // caller and can be collected when the caller releases it. A fresh query in
  // native import() would instead permanently retain each runtime and its
  // captured fetch/cache closures in Node's module map.
  const module = new SourceTextModule(code, {
    identifier: moduleUrl,
    initializeImportMeta(meta) {
      meta.url = moduleUrl;
    },
    async importModuleDynamically(specifier) {
      throw new Error(`Unprovided dynamic production artifact dependency: ${specifier}`);
    },
  });
  await module.link(async specifier => {
    if (specifier !== ortWebGpuUrl && specifier !== ortCommonUrl) {
      throw new Error(`Unprovided static production artifact dependency: ${specifier}`);
    }
    const namespace = await nativeImport({ moduleUrl: specifier }) as Record<string, unknown>;
    const exports = Object.keys(namespace);
    return new SyntheticModule(exports, function () {
      for (const name of exports) this.setExport(name, namespace[name]);
    }, { identifier: specifier });
  });
  await module.evaluate();
  return module.namespace;
}

export async function importProductionTransformersArtifact({ moduleUrl }: { moduleUrl: string }): Promise<unknown> {
  const artifact = await getProductionTransformersArtifact();
  const requested = new URL(moduleUrl);
  requested.search = '';
  if (requested.href !== artifact.moduleUrl) {
    throw new Error('Native replay import must use this fixture\'s verified production artifact');
  }
  const code = await readFile(new URL(artifact.moduleUrl), 'utf8');
  if (createHash('sha256').update(code).digest('hex') !== artifact.artifactSha256) {
    throw new Error('Production replay artifact bytes changed before evaluation');
  }
  // Even the same URL deliberately evaluates a fresh runtime. Queries remain
  // diagnostic identities, not cache keys. The native ORT dependencies above
  // retain their real identities; Transformers.js env is never shared.
  return evaluateArtifactModule({ code, moduleUrl, ortWebGpuUrl: artifact.ortWebGpuUrl, ortCommonUrl: artifact.ortCommonUrl });
}

afterAll(async () => {
  for (const directory of ownedDirectories) {
    await rm(directory, { recursive: true, force: true });
    ownedDirectories.delete(directory);
  }
});

export const TEST_ONLY = {
  evaluateArtifactModule,
};
