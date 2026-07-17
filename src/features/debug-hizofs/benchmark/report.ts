import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkReport,
  HizoFSBenchmarkStudyReport,
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
  return JSON.stringify(createHizoFSBenchmarkSummary({ report }), undefined, 2);
}

export function serializeHizoFSBenchmarkStudyFullReport({
  report,
}: {
  report: HizoFSBenchmarkStudyReport;
}): string {
  return JSON.stringify(report, undefined, 2);
}

export function serializeHizoFSBenchmarkStudySummaryReport({
  report,
}: {
  report: HizoFSBenchmarkStudyReport;
}): string {
  const {
    variants,
    ...reportWithoutVariants
  } = report;
  return JSON.stringify({
    ...reportWithoutVariants,
    variants: variants.map(variant => ({
      variantId: variant.variantId,
      label: variant.label,
      report: createHizoFSBenchmarkSummary({ report: variant.report }),
    })),
  }, undefined, 2);
}

function createHizoFSBenchmarkSummary({
  report,
}: {
  report: HizoFSBenchmarkReport;
}): Omit<HizoFSBenchmarkReport, 'results' | 'failure'> & {
  readonly results: readonly ReturnType<typeof createCaseSummary>[];
  readonly failure: HizoFSBenchmarkReport['failure'];
} {
  const {
    results,
    failure,
    ...reportWithoutResultsAndFailure
  } = report;
  return {
    ...reportWithoutResultsAndFailure,
    results: results.map(result => createCaseSummary({ result })),
    failure: failure === undefined
      ? undefined
      : {
        ...failure,
        errorStack: undefined,
      },
  };
}

function createCaseSummary({
  result,
}: {
  result: HizoFSBenchmarkReport['results'][number];
}) {
  return {
    ...result,
    backends: {
      rawOpfs: result.backends.rawOpfs === undefined
        ? undefined
        : omitSamples({ result: result.backends.rawOpfs }),
      hizofs: result.backends.hizofs === undefined
        ? undefined
        : omitSamples({ result: result.backends.hizofs }),
    },
  };
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
