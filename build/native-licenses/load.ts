import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { importLlamaLicenseIndex } from './llama-index';
import { importImageLicenseIndex } from './image-index';
import { assertNativeLicenseTypeContract } from './typecheck';
import { collectNativeLicenseDependencies, type NativeLicenseSource } from './collect';
import type { NativeLicenseIndex } from './index-types';

// Only arbitrary externally selected directories need runtime shape validation.
// Installed JSONs use literal imports + satisfies, checked before consuming them.
const externalIndexSchema = z.object({
  components: z.array(z.object({
    id: z.string(),
    name: z.string(),
    version: z.string().nullable(),
    license: z.string().nullable(),
    notices: z.array(z.object({ path: z.string(), sourcePath: z.string().optional() })),
  })),
}) satisfies z.ZodType<NativeLicenseIndex>;

export async function readNativeLicenseDependencies({ source, watchFile }: {
  source: NativeLicenseSource;
  watchFile: (filePath: string) => void;
}) {
  for (const file of source.manifestPaths) {
    watchFile(file);
  }
  if (!source.files.has('native-license-index.json')) {
    throw new Error(`The ${source.runtime} artifact has no native-license-index.json; install bicore artifacts with structured native notices.`);
  }
  const file = source.readArtifact({ relative: 'native-license-index.json' });
  watchFile(file.filePath);
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data));
  let index: NativeLicenseIndex;
  switch (source.kind) {
  case 'external':
    index = externalIndexSchema.parse(parsed);
    break;
  case 'installed': {
    const specifier = `${source.runtime}-browser-core/${source.runtime}/native-license-index.json`;
    const resolved = createRequire(path.join(source.rootDir, 'package.json')).resolve(specifier);
    if (realpathSync(resolved) !== realpathSync(file.filePath)) {
      throw new Error('Native license import and runtime artifact resolve to different packages');
    }
    const adapter = { 'llama-cpp': 'llama-index.ts', 'stable-diffusion-cpp': 'image-index.ts' } satisfies Record<NativeLicenseSource['runtime'], string>;
    assertNativeLicenseTypeContract({ fileName: path.join(source.rootDir, 'build/native-licenses', adapter[source.runtime]) });
    switch (source.runtime) {
    case 'llama-cpp': index = await importLlamaLicenseIndex();
      break;
    case 'stable-diffusion-cpp': index = await importImageLicenseIndex();
      break;
    default: {
      const exhaustive: never = source.runtime;
      throw new Error(`Unknown native runtime: ${exhaustive}`);
    }
    }
    // Parsing above is only an identity comparison, never an unchecked cast.
    // Catch bundled/config-loader or Node module-cache snapshots of another JSON.
    if (!isDeepStrictEqual(index, parsed)) {
      throw new Error('Native license import differs from the verified artifact; restart the build after updating dependencies');
    }
    break;
  }
  default: {
    const exhaustive: never = source.kind;
    throw new Error(`Unknown native license source: ${exhaustive}`);
  }
  }
  return collectNativeLicenseDependencies({ source, index, watchFile });
}

export const TEST_ONLY = {
  externalIndexSchema,
};
