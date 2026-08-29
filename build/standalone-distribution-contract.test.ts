import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function readRepositoryFile({ fileName }: {
  fileName: string;
}): string {
  return fs.readFileSync(path.resolve(process.cwd(), fileName), 'utf8');
}

describe('standalone distribution contract', () => {
  it('keeps separate convenience artifacts for the universal package and all locale packages', () => {
    const workflow = readRepositoryFile({ fileName: '.github/workflows/main.yml' });
    expect(workflow).toContain('name: standalone-universal-package');
    expect(workflow).toContain('name: standalone-all-locale-packages');
    expect(workflow).toMatch(/standalone-all-locale-packages[\s\S]*dist\/naidan-standalone\.zip[\s\S]*dist\/naidan-standalone-\*\.zip/u);
    expect(workflow).toContain('mapfile -t STANDALONE_LOCALES');
    expect(workflow).toContain("import { UI_LOCALES } from './src/01-models/ui-locale.ts'");
    expect(workflow).toContain('test -f "dist/naidan-standalone-${LOCALE}.zip"');
  });

  it('publishes every locale package to GitHub Release without renaming the universal public convention', () => {
    const workflow = readRepositoryFile({ fileName: '.github/workflows/main.yml' });
    expect(workflow).toContain('mv dist/naidan-standalone.zip dist/naidan-standalone-${TAG}.zip');
    expect(workflow).toContain('for ZIP_PATH in dist/naidan-standalone-*.zip; do');
    expect(workflow).toContain('dist/naidan-standalone-*-${{ steps.get_tag.outputs.TAG_NAME }}.zip');
  });

  it('serves locale packages but intentionally keeps them out of PWA precache', () => {
    const viteConfig = readRepositoryFile({ fileName: 'vite.config.ts' });
    const hostedPackages = readRepositoryFile({ fileName: 'build/hosted-standalone-packages.ts' });
    expect(viteConfig).toContain("includeAssets: ['favicon.svg', 'naidan-standalone.zip']");
    expect(viteConfig).toContain("'**/naidan-standalone-*.zip'");
    expect(viteConfig).toContain('intentionally not');
    expect(viteConfig).toContain('copyStandalonePackagesToHosted');
    expect(viteConfig).toContain('locales: UI_LOCALES');
    expect(hostedPackages).toContain('...locales.map(locale => `naidan-standalone-${locale}.zip`)');
    expect(hostedPackages).toContain('Incomplete standalone package set');
  });

  it.each([
    'src/components/WelcomeScreen.vue',
    'src/components/AboutTab.vue',
    'src/components/SettingsModal.vue',
  ])('routes Portable App downloads through the shared current-locale composable in %s', (fileName) => {
    const source = readRepositoryFile({ fileName });
    expect(source).toContain("@/features/file-protocol-standalone/composables/usePortableAppDownload");
    expect(source).toContain(':href="portableAppDownload.href"');
    expect(source).toContain(':download="portableAppDownload.fileName"');
    expect(source).not.toContain('href="./naidan-standalone.zip"');
  });
});
