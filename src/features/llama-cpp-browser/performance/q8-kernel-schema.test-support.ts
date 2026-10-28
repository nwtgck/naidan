import { q8KernelShapes, q8KernelVariants, type Q8KernelBenchmark, type Q8KernelShape, type Q8KernelSample } from './q8-kernel-schema';

/** Schema-only data, not timings or output from an executed GPU runtime. */
export function createQ8BenchmarkWireFixture(): Q8KernelBenchmark {
  return {
    version: 1,
    fixtureId: 'q8-dyadic-v1',
    status: 'complete',
    repetitions: 32,
    rounds: 4,
    shapes: q8KernelShapes.map(([k, m]) => {
      const shape: Q8KernelShape = {
        k,
        m,
        fixture: { seed: 1, weightBytes: k / 32 * 34 * m, inputBytes: k * 4, outputBytes: m * 4, weightSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64), expectedSha256: 'c'.repeat(64), maximumAbsoluteIntegerSum: k * 64 },
        variants: [],
        samples: [],
        inputsUnchanged: { weights: true, input: true, guards: true, weightBytes: k / 32 * 34 * m, inputBytes: k * 4, weightSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) },
      };
      shape.variants = q8KernelVariants.map((variant, i) => {
        const independent = variant.startsWith('independent') || variant === 'auto';
        const rows = variant.endsWith('r1') ? 1 : variant.endsWith('r2') || variant === 'auto' ? 2 : 4;
        const outputs = independent ? rows * 16 : rows;
        const report: Q8KernelShape['variants'][number]['prepare']['report'] = {
          status: 'ok',
          variant,
          phase: 'prepare',
          algorithm: independent ? 'independent' : 'cooperative',
          workgroupSize: { auto: 128, 'cooperative-wg256-r4': 256, 'independent-wg128-r4': 128, 'independent-wg128-r1': 128, 'independent-wg128-r2': 128, 'cooperative-wg128-r2': 128 }[variant],
          logicalSubgroupSize: independent ? 8 : 0,
          realMinSubgroupSize: 8,
          realMaxSubgroupSize: 8,
          rowsPerTile: rows,
          outputsPerWorkgroup: outputs,
          cooperativeSubgroupReduction: !independent,
          grid: { x: Math.ceil(m / outputs), y: 1, z: 1 },
          dispatches: 0,
          codegenRevision: 1,
          shaderSha256: 'a' + i.toString(16).repeat(63),
          nativeWallMs: 1,
        };
        return {
          variant,
          prepare: { report, wallMs: 2 },
          warmup: {
            call: { report: { ...report, phase: 'execute', dispatches: 1 }, wallMs: 2 },
            readbackMs: 1,
            exact: { words: m, mismatches: 0, expectedSha256: 'c'.repeat(64), actualSha256: 'c'.repeat(64), guards: true },
          },
        };
      });
      for (let round = 0; round < 4; round++) {
        const order = round % 2 ? [...q8KernelVariants].reverse() : [...q8KernelVariants];
        for (const [position, variant] of order.entries()) {
          const report = shape.variants.find(row => row.variant === variant)!.prepare.report;
          const sample: Q8KernelSample = {
            variant,
            round,
            position,
            report: { ...report, phase: 'execute', dispatches: 32 },
            wallMs: 3,
            timingStatus: 'measured',
            gpuMsPerDispatch: 0.5,
            readbackMs: 1,
            exact: { words: m, mismatches: 0, expectedSha256: 'c'.repeat(64), actualSha256: 'c'.repeat(64), guards: true },
            gpuProfile: {
              version: 1,
              source: 'webgpu-pass-timestamps',
              status: 'complete',
              observedPasses: 32,
              measuredPasses: 32,
              pendingPasses: 0,
              invalidPasses: 0,
              droppedPasses: 0,
              ungroupedPasses: 0,
              ambiguousPasses: 0,
              instrumentationErrors: 0,
              zeroDurationPasses: 0,
              totalGpuMs: 16,
              precision: 'browser-defined',
              rows: [{
                phase: 'other',
                shader: 'fixture',
                workgroups: [report.grid.x, 1, 1],
                passes: 32,
                dispatches: 32,
                multiDispatchPasses: 0,
                totalGpuMs: 16,
                meanPassMs: 0.5,
                minimumPassMs: 0.5,
                maximumPassMs: 0.5,
                zeroDurationPasses: 0,
              }],
            },
          };
          shape.samples.push(sample);
        }
      }
      return shape;
    }),
  };
}
