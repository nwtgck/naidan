import { describe, expect, it } from 'vitest';
import {
  createHizoFSBenchmarkPresetConfiguration,
  estimateHizoFSBenchmarkWrittenBytes,
} from './presets';
import { hizoFSBenchmarkConfigurationSchema } from './types';

describe('HizoFS benchmark presets', () => {
  it('produces schema-valid quick, standard, and stress configurations', () => {
    for (const preset of ['quick', 'standard', 'stress'] as const) {
      expect(hizoFSBenchmarkConfigurationSchema.parse(
        createHizoFSBenchmarkPresetConfiguration({ preset }),
      ).preset).toBe(preset);
    }
  });

  it('estimates more writes for the stress preset than quick', () => {
    const quick = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const stress = createHizoFSBenchmarkPresetConfiguration({ preset: 'stress' });
    expect(estimateHizoFSBenchmarkWrittenBytes({ configuration: stress }))
      .toBeGreaterThan(estimateHizoFSBenchmarkWrittenBytes({ configuration: quick }));
  });
  it('estimates maintenance writes only for HizoFS and sequential content bytes precisely', () => {
    const quick = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const maintenanceOnly = {
      ...quick,
      backendMode: 'compare' as const,
      workloads: ['hizofs_maintenance' as const],
      warmupIterations: 0,
      measuredIterations: 1,
    };
    const hizofsOnly = {
      ...maintenanceOnly,
      backendMode: 'hizofs_only' as const,
    };
    expect(estimateHizoFSBenchmarkWrittenBytes({ configuration: maintenanceOnly }))
      .toBe(estimateHizoFSBenchmarkWrittenBytes({ configuration: hizofsOnly }));

    const sequentialOnly = {
      ...quick,
      backendMode: 'compare' as const,
      workloads: ['sequential_io' as const],
      warmupIterations: 0,
      measuredIterations: 1,
    };
    expect(estimateHizoFSBenchmarkWrittenBytes({ configuration: sequentialOnly })).toBe(
      2 * (quick.sequentialIo.fileSizeBytes + quick.sequentialIo.blockSizeBytes),
    );
  });

});
