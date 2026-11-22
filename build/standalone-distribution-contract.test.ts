import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPWABuild } from './pwa';

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

  it('publishes every staged package from the same signed candidate to GitHub Releases', () => {
    const workflow = readRepositoryFile({ fileName: '.github/workflows/main.yml' });
    const stable = readRepositoryFile({ fileName: '.github/workflows/sync-release-notes.yml' });
    const prerelease = workflow.split('  prerelease_to_github:\n')[1];
    expect(workflow).toContain('distribution-artifact-id: ${{ needs.prepare_release.outputs.artifact-id }}');
    expect(stable).toContain('artifact-ids: ${{ inputs.distribution-artifact-id }}');
    expect(stable).toContain('files: ${{ runner.temp }}/distribution/assets/*');
    expect(prerelease).toContain('artifact-ids: ${{ needs.prepare_release.outputs.artifact-id }}');
    expect(prerelease).toContain('gh release create "$TAG" "$RUNNER_TEMP"/distribution/assets/*');
  });

  it('serves locale packages but intentionally keeps them out of PWA precache', () => {
    const viteConfig = readRepositoryFile({ fileName: 'vite.config.ts' });
    const hostedPackages = readRepositoryFile({ fileName: 'build/hosted-standalone-packages.ts' });
    // Assert the shared production options, not their spelling or location in
    // vite.config.ts. The generated-worker test in pwa.test.ts also verifies
    // that every supported locale ZIP is served but never precached.
    const { options } = createPWABuild({ buildId: 'standalone-distribution-contract' });
    expect(options.includeAssets).toContain('favicon.svg');
    expect(options.includeAssets).not.toContain('naidan-standalone.zip');
    expect(options.strategies).toBe('injectManifest');
    expect(options.injectManifest?.globPatterns).toContain('**/*');
    expect(options.injectManifest?.globIgnores).toContain('**/naidan-standalone-*.zip');
    expect(viteConfig).toContain('copyStandalonePackagesToHosted');
    expect(viteConfig).toContain('locales: UI_LOCALES');
    expect(hostedPackages).toContain('...locales.map(locale => `naidan-standalone-${locale}.zip`)');
    expect(hostedPackages).toContain('Incomplete standalone package set');
  });

  it.each([
    { fileName: 'src/components/WelcomeScreen.vue', downloadFileName: 'src/components/WelcomeScreen.vue' },
    { fileName: 'src/components/AboutTab.vue', downloadFileName: 'src/components/AboutTab.vue' },
    { fileName: 'src/components/SettingsModal.vue', downloadFileName: 'src/components/SettingsNavigation.vue' },
  ])('routes Portable App downloads through the shared current-locale composable in $fileName', ({ fileName, downloadFileName }) => {
    const source = readRepositoryFile({ fileName });
    const downloadSource = readRepositoryFile({ fileName: downloadFileName });
    expect(source).toContain("@/features/file-protocol-standalone/composables/usePortableAppDownload");
    if (fileName !== downloadFileName) {
      expect(source).toContain(':portable-app-download="portableAppDownload"');
    }
    expect(downloadSource).toContain(':href="portableAppDownload.href"');
    expect(downloadSource).toContain(':download="portableAppDownload.fileName"');
    expect(source).not.toContain('href="./naidan-standalone.zip"');
    expect(downloadSource).not.toContain('href="./naidan-standalone.zip"');
  });
});
