import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { afterAll } from 'vitest';
import { buildTransformersJsFixesArtifact } from '../../../../../build/transformers-js-fixes/artifact';

// Share build mechanics, never an evaluated Transformers.js runtime instance.
// Consumers append their own query identity before each native import.
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

// A constant native import boundary prevents Vitest's jsdom module runner from
// resolving or transforming Vite's already-built bytes again. The URL is an
// argument, never interpolated source, and must name this fixture's own artifact.
type NativeImport = ({ moduleUrl }: { moduleUrl: string }) => Promise<unknown>;
const nativeImport = compileFunction('return import(input.moduleUrl)', ['input'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as NativeImport;

export async function importProductionTransformersArtifact({ moduleUrl }: { moduleUrl: string }): Promise<unknown> {
  const artifact = await getProductionTransformersArtifact();
  const requested = new URL(moduleUrl);
  requested.search = '';
  if (requested.href !== artifact.moduleUrl) {
    throw new Error('Native replay import must use this fixture\'s verified production artifact');
  }
  // Each consumer keeps its fresh query identity and narrows the unknown module
  // to the external API it observes; model selection expectations stay local.
  return nativeImport({ moduleUrl });
}

afterAll(async () => {
  for (const directory of ownedDirectories) {
    await rm(directory, { recursive: true, force: true });
    ownedDirectories.delete(directory);
  }
});

export const TEST_ONLY = {
};
