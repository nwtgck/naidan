import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listModelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { createSiteSitemap } from './site-sitemap';
import { renderModelPageHtml, renderPublicAppHtml } from './model-page-html';

/** Build a separate overlay; never mutate either portable release package. */
export async function buildModelPagePublication({ hostedDirectory, outputDirectory }: { hostedDirectory: string, outputDirectory: string }): Promise<void> {
  const hosted = path.resolve(hostedDirectory);
  const output = path.resolve(outputDirectory);
  const staging = `${output}.staging`;
  const overlaps = [output, staging].flatMap(directory => [path.relative(hosted, directory), path.relative(directory, hosted)]).some(relative =>
    relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
  if (overlaps) {
    throw new Error('Model publication output must not overlap the hosted package');
  }
  const html = await readFile(path.join(hosted, 'index.html'), 'utf8');
  const entries = listModelPageEntries();
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const entry of entries) {
      // Paths are derived only from validated bundled entries, never a request.
      const directory = path.join(staging, entry.pathname.slice(1));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'index.html'), renderModelPageHtml({ html, entry }));
    }
    await writeFile(path.join(staging, 'sitemap.xml'), createSiteSitemap({ entries }));
    // No root 404: Cloudflare serves this shell for unpublished repositories.
    // Docs keeps its nearer docs/404.html; portable packages are unchanged.
    await writeFile(path.join(staging, 'index.html'), renderPublicAppHtml({ html }));
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export const TEST_ONLY = {
};
