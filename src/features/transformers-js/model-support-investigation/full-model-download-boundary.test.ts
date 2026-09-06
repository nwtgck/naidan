import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function productionSourceFiles({ root }: { root: string }): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const fullPath = path.join(root, name);
    if (statSync(fullPath).isDirectory()) {
      files.push(...productionSourceFiles({ root: fullPath }));
      continue;
    }
    if (!/\.(?:ts|vue)$/u.test(name) || name.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

describe('Model Support Investigation full-model-download boundary', () => {
  it('does not make full-artifact download capabilities reachable from MSI production sources', () => {
    const root = path.resolve(process.cwd(), 'src/features/transformers-js/model-support-investigation');
    const prohibited = [
      'runProductionDownloadPreparation',
      'prepareProductionModelCandidate',
      '.prefetchUrls(',
    ];

    const violations = productionSourceFiles({ root }).flatMap(filePath => {
      const source = readFileSync(filePath, 'utf8');
      return prohibited
        .filter(token => source.includes(token))
        .map(token => `${path.relative(process.cwd(), filePath)} contains ${token}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps runtime-complete Download Evidence cache-only', () => {
    const sourcePath = path.resolve(
      process.cwd(),
      'src/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('runProductionDownloadPreparation');
    expect(source).not.toContain('prepareProductionModelCandidate');
    expect(source).not.toContain('.prefetchUrls(');
    expect(source).toContain('Model Support Investigation does not download, resume, repair, or complete model weight artifacts');
  });
});
