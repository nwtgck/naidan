import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listModelSeoEntries } from '../src/features/llama-cpp-browser/model-launch/seo-entries';
import { createSiteSitemap } from './site-sitemap';
import { renderModelSeoHtml, modelSeoNotFoundHtml } from './model-seo-html';

/** Build a separate overlay; never mutate either portable release package. */
export async function buildModelSeoPublication({ hostedDirectory, outputDirectory }: { hostedDirectory: string, outputDirectory: string }): Promise<void> {
  const hosted = path.resolve(hostedDirectory);
  const output = path.resolve(outputDirectory);
  const staging = `${output}.staging`;
  const overlaps = [output, staging].flatMap(directory => [path.relative(hosted, directory), path.relative(directory, hosted)]).some(relative =>
    relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
  if (overlaps) {
    throw new Error('Model publication output must not overlap the hosted package');
  }
  const html = await readFile(path.join(hosted, 'index.html'), 'utf8');
  const entries = listModelSeoEntries();
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const entry of entries) {
      // Paths are derived only from validated bundled entries, never a request.
      const directory = path.join(staging, entry.pathname.slice(1));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'index.html'), renderModelSeoHtml({ html, entry }));
    }
    await writeFile(path.join(staging, 'sitemap.xml'), createSiteSitemap({ entries }));
    // Disables Cloudflare's catch-all SPA 200 response. App routes use hashes;
    // Docs retains its own nearer docs/404.html in the publication assembly.
    await writeFile(path.join(staging, '404.html'), modelSeoNotFoundHtml());
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export const TEST_ONLY = {
};
