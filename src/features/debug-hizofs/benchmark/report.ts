import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkReport,
} from './types';

export function serializeHizoFSBenchmarkConfiguration({
  configuration,
}: {
  configuration: HizoFSBenchmarkConfiguration;
}): string {
  return JSON.stringify(configuration, undefined, 2);
}

export function serializeHizoFSBenchmarkFullReport({
  report,
}: {
  report: HizoFSBenchmarkReport;
}): string {
  return JSON.stringify(report, undefined, 2);
}

export function serializeHizoFSBenchmarkSummaryReport({
  report,
}: {
  report: HizoFSBenchmarkReport;
}): string {
  const {
    results,
    failure,
    ...reportWithoutResultsAndFailure
  } = report;
  const summary = {
    ...reportWithoutResultsAndFailure,
    results: results.map(result => ({
      ...result,
      backends: {
        rawOpfs: result.backends.rawOpfs === undefined
          ? undefined
          : omitSamples({ result: result.backends.rawOpfs }),
        hizofs: result.backends.hizofs === undefined
          ? undefined
          : omitSamples({ result: result.backends.hizofs }),
      },
    })),
    failure: failure === undefined
      ? undefined
      : {
        ...failure,
        errorStack: undefined,
      },
  };
  return JSON.stringify(summary, undefined, 2);
}

function omitSamples({
  result,
}: {
  result: NonNullable<HizoFSBenchmarkReport['results'][number]['backends']['rawOpfs']>;
}): Omit<typeof result, 'samples'> {
  const { samples: _samples, ...summary } = result;
  return summary;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
