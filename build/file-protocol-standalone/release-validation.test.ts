import { describe, expect, it } from 'vitest';

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
  it('requires evidence for an external source audit summary', () => {
    expect(() => createFileProtocolStandaloneReleaseValidationPlugin({
      ...createOptions(),
      sourceAudit: { mode: 'external', evidence: '   ' },
    })).toThrow('sourceAudit.evidence is required for external source audit');
  });

});
