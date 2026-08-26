import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FILE_PROTOCOL_STANDALONE_ELEMENT_IDS } from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';
import { createFileProtocolStandaloneReleaseValidationPlugin } from './release-validation.js';

function createOptions() {
  return {
    outputDirectory: '/tmp/naidan-standalone-output',
    workers: [{ name: 'worker', sourceEntry: '/tmp/worker.ts' }],
    runtimeFileNames: ['file-protocol-standalone/system.min.js'],
    debugReportFile: '/tmp/naidan-standalone-debug.json',
    releaseReportFile: '/tmp/naidan-standalone-release.json',
  };
}

describe('createFileProtocolStandaloneReleaseValidationPlugin', () => {
  it('rejects duplicate Worker names and source entries before writeBundle', () => {
    expect(() => createFileProtocolStandaloneReleaseValidationPlugin({
      ...createOptions(),
      workers: [
        { name: 'duplicate', sourceEntry: '/tmp/worker-a.ts' },
        { name: 'duplicate', sourceEntry: '/tmp/worker-b.ts' },
      ],
    })).toThrow('Duplicate release Worker name');

    expect(() => createFileProtocolStandaloneReleaseValidationPlugin({
      ...createOptions(),
      workers: [
        { name: 'worker-a', sourceEntry: '/tmp/duplicate.ts' },
        { name: 'worker-b', sourceEntry: '/tmp/duplicate.ts' },
      ],
    })).toThrow('Duplicate release Worker sourceEntry');
  });

  it('keeps release reports outside the runtime output directory', () => {
    expect(() => createFileProtocolStandaloneReleaseValidationPlugin({
      ...createOptions(),
      debugReportFile: '/tmp/naidan-standalone-output/debug.json',
    })).toThrow('debugReportFile must live outside');
  });
  it('uses parsed final HTML semantics when collecting release stylesheet files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-release-html-'));
    const outputDirectory = path.join(root, 'dist');
    const debugReportFile = path.join(root, 'debug.json');
    const releaseReportFile = path.join(root, 'release.json');
    const uiSourceEntry = path.join(root, 'ui.ts');
    const workerSourceEntry = path.join(root, 'worker.ts');
    try {
      await fs.mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(outputDirectory, 'index.html'), `\
<!doctype html><html><head><link href=./public.css rel=stylesheet>
<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime)} src=./system.min.js></script>
<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch)} src=./system.min.js></script>
<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook)} src=./system.min.js></script>
<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap)}>System.import("./assets/ui.js");</script>
</head><body></body></html>`),
        fs.writeFile(path.join(outputDirectory, 'public.css'), 'body {}'),
        fs.writeFile(path.join(outputDirectory, 'system.min.js'), 'System = {};'),
        fs.writeFile(path.join(outputDirectory, 'assets/ui.js'), 'System.register([], function () {});'),
        fs.writeFile(path.join(outputDirectory, 'assets/worker.js'), 'System.register([], function () {});'),
      ]);

      const plugin = createFileProtocolStandaloneReleaseValidationPlugin({
        outputDirectory,
        workers: [{ name: 'worker', sourceEntry: workerSourceEntry }],
        runtimeFileNames: ['system.min.js'],
        debugReportFile,
        releaseReportFile,
      });
      const writeBundle = plugin.writeBundle;
      if (typeof writeBundle !== 'function') throw new Error('Expected release validation writeBundle hook');
      await writeBundle.call(
        {} as never,
        {} as never,
        {
          'assets/ui.js': {
            type: 'chunk', fileName: 'assets/ui.js', name: 'ui', isEntry: true, isDynamicEntry: false,
            facadeModuleId: uiSourceEntry, imports: [], dynamicImports: [], modules: {},
          },
          'assets/worker.js': {
            type: 'chunk', fileName: 'assets/worker.js', name: 'worker', isEntry: true, isDynamicEntry: false,
            facadeModuleId: workerSourceEntry, imports: [], dynamicImports: [], modules: {},
          },
        } as never,
      );

      const releaseReport: unknown = JSON.parse(await fs.readFile(releaseReportFile, 'utf8'));
      expect(releaseReport).toMatchObject({
        passed: true,
        metrics: {
          ui: {
            initialFiles: expect.arrayContaining(['public.css']),
          },
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('requires evidence for an external source audit summary', () => {
    expect(() => createFileProtocolStandaloneReleaseValidationPlugin({
      ...createOptions(),
      sourceAudit: { mode: 'external', evidence: '   ' },
    })).toThrow('sourceAudit.evidence is required for external source audit');
  });

});
