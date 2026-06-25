import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build as viteBuild } from 'vite';

import { omitBuildOutputFilesPlugin } from './omit-build-output-files';

const fixtureRoots: string[] = [];

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omit-build-output-files-test-'));
  fixtureRoots.push(root);
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), `\
<!doctype html>
<html><body><script type="module" src="/src.ts"></script></body></html>
`);
  await fs.writeFile(path.join(root, 'src.ts'), 'document.body.dataset.ready = "true"');
  await fs.writeFile(path.join(root, 'public/robots.txt'), `\
User-agent: *
Disallow:
`);
  await fs.writeFile(path.join(root, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

async function buildFixture({ root, outputName, omitRobots }: {
  root: string,
  outputName: string,
  omitRobots: 'omit' | 'preserve',
}): Promise<string> {
  const outputDirectory = path.join(root, outputName);
  await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: omitRobots === 'omit'
      ? [omitBuildOutputFilesPlugin({ fileNames: ['robots.txt'] })]
      : [],
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: false,
    },
  });
  return outputDirectory;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('omitBuildOutputFilesPlugin', () => {
  it('omits robots.txt from standalone output while preserving other public assets', async () => {
    const root = await createFixture();
    const outputDirectory = await buildFixture({
      root,
      outputName: 'dist/standalone',
      omitRobots: 'omit',
    });

    await expect(fs.stat(path.join(outputDirectory, 'robots.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.readFile(path.join(outputDirectory, 'favicon.svg'), 'utf8')).resolves.toContain('<svg');
  });

  it('preserves robots.txt when the omission plugin is not used for hosted output', async () => {
    const root = await createFixture();
    const outputDirectory = await buildFixture({
      root,
      outputName: 'dist/hosted',
      omitRobots: 'preserve',
    });

    await expect(fs.readFile(path.join(outputDirectory, 'robots.txt'), 'utf8')).resolves.toBe(
      `\
User-agent: *
Disallow:
`,
    );
  });

  it('rejects paths outside the configured build output', async () => {
    const root = await createFixture();

    await expect(viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [omitBuildOutputFilesPlugin({ fileNames: ['../robots.txt'] })],
      build: {
        outDir: path.join(root, 'dist/standalone'),
        emptyOutDir: true,
        minify: false,
      },
    })).rejects.toThrow('Cannot omit a file outside the build output');
  });
});
