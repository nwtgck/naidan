import type { ImageDiagnosticInput, createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { MeasurementPoint, MeasurementOutcome } from './gpu-performance';
export type PerformancePhase = 'runtime' | 'model-header' | 'model-load' | 'prepare' | 'conditioning' | 'sampling' | 'decoding' | 'encoding' | 'cleanup';
export type NativePerformanceSignal = { kind: 'conditioning' } | { kind: 'sampling-progress', step: number, steps: number };
const emptyPhases = () => ({ runtime: 0, 'model-header': 0, 'model-load': 0, prepare: 0, conditioning: 0, sampling: 0, decoding: 0, encoding: 0, cleanup: 0 });
const emptyPlacement = () => ({
  allocationReports: 0,
  invalidReports: 0,
  assignedNodes: 0,
  cpuNodes: 0,
  webgpuNodes: 0,
  otherNodes: 0,
  bf16WeightMatmuls: 0,
  inspectedBf16WeightMatmuls: 0,
  cpuBf16WeightMatmuls: 0,
  webgpuBf16WeightMatmuls: 0,
  otherBf16WeightMatmuls: 0,
  cpuBf16WebgpuUnsupported: 0,
  webgpuBf16WeightUses: 0,
  hostBf16WeightUses: 0,
  otherBf16WeightUses: 0,
  scheduledWebgpuToCpuBf16WeightUses: 0,
  scheduledWebgpuToCpuBf16WeightUseBytes: 0,
});

function parsePlacement({ message }: { message: string }): ReturnType<typeof emptyPlacement> | 'invalid' | undefined {
  if (!/^compute_workspace\.cpp:\d+\s+- browser-placement-v1\b/.test(message)) return undefined;
  const match = /^compute_workspace\.cpp:\d+\s+- browser-placement-v1 nodes=(\d+) cpu=(\d+) webgpu=(\d+) other=(\d+) bf16=(\d+) inspected=(\d+) cpu_bf16=(\d+) webgpu_bf16=(\d+) other_bf16=(\d+) cpu_unsupported_bf16=(\d+) webgpu_weights=(\d+) host_weights=(\d+) other_weights=(\d+) webgpu_cpu_bf16=(\d+) webgpu_cpu_bf16_use_bytes=(\d+)\s*$/.exec(message);
  if (!match) return 'invalid';
  const values = match.slice(1).map(Number);
  if (values.some(value => !Number.isSafeInteger(value))) return 'invalid';
  const [nodes, cpu, webgpu, other, bf16, inspected, cpuBf16, webgpuBf16, otherBf16, unsupported, gpuWeights, hostWeights, otherWeights, gpuCpu, gpuCpuBytes] = values;
  if (nodes === undefined || cpu === undefined || webgpu === undefined || other === undefined || bf16 === undefined || inspected === undefined || cpuBf16 === undefined || webgpuBf16 === undefined || otherBf16 === undefined || unsupported === undefined || gpuWeights === undefined || hostWeights === undefined || otherWeights === undefined || gpuCpu === undefined || gpuCpuBytes === undefined) return 'invalid';
  if (cpu + webgpu + other !== nodes || bf16 > nodes || inspected > bf16 || cpuBf16 + webgpuBf16 + otherBf16 !== inspected || gpuWeights + hostWeights + otherWeights !== inspected || cpuBf16 > cpu || webgpuBf16 > webgpu || otherBf16 > other || unsupported > cpuBf16 || gpuCpu > cpuBf16 || gpuCpu > gpuWeights || (gpuCpu === 0 && gpuCpuBytes !== 0)) return 'invalid';
  return {
    allocationReports: 1,
    invalidReports: 0,
    assignedNodes: nodes,
    cpuNodes: cpu,
    webgpuNodes: webgpu,
    otherNodes: other,
    bf16WeightMatmuls: bf16,
    inspectedBf16WeightMatmuls: inspected,
    cpuBf16WeightMatmuls: cpuBf16,
    webgpuBf16WeightMatmuls: webgpuBf16,
    otherBf16WeightMatmuls: otherBf16,
    cpuBf16WebgpuUnsupported: unsupported,
    webgpuBf16WeightUses: gpuWeights,
    hostBf16WeightUses: hostWeights,
    otherBf16WeightUses: otherWeights,
    scheduledWebgpuToCpuBf16WeightUses: gpuCpu,
    scheduledWebgpuToCpuBf16WeightUseBytes: gpuCpuBytes,
  };
}

function parseWeightConversion({ message }: { message: string }) {
  const match = /^model_manager\.cpp:\d+\s+- browser-weight-conversion-v1 target=(f32|f16) tensors=(\d+) source_bytes=(\d+) destination_bytes=(\d+) extra_bytes=(\d+)\s*$/.exec(message);
  if (!match) return undefined;
  const target = match[1], values = match.slice(2).map(Number);
  if (target !== 'f32' && target !== 'f16') return undefined;
  if (values.some(value => !Number.isSafeInteger(value))) return undefined;
  const [tensors, sourceBytes, destinationBytes, extraBytes] = values;
  if (tensors === undefined || sourceBytes === undefined || destinationBytes === undefined || extraBytes === undefined || tensors < 1 || sourceBytes < 1) return undefined;
  const multiplier = (() => {
    switch (target) {
    case 'f32': return 2;
    case 'f16': return 1;
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  })();
  if (destinationBytes !== sourceBytes * multiplier || extraBytes !== destinationBytes - sourceBytes) return undefined;
  return { target, tensors, sourceBytes, destinationBytes, extraBytes };
}

/** Bounded per-run wall timeline. Only the REAL native progress callback starts
 * denoising; the earlier UI step=0 also includes text conditioning. Native log
 * summaries below are independently reported (rounded) clocks, not disjoint
 * spans to add to this timeline. No arbitrary log text is retained or emitted. */
export function createRunPerformance({ enabled, request, emit, checkpoint, now = () => performance.now() }: {
  enabled: boolean, request: Request, emit: ReturnType<typeof createImageTrace>['emit'],
  checkpoint: ({ point }: { point: MeasurementPoint }) => void, now?: () => number,
}) {
  const began = enabled ? now() : 0;
  let phase: PerformancePhase = 'runtime', phaseStart = began, closed = false;
  let step = 0, stepsSeen = 0, stepStart: number | undefined, stepSum = 0, stepMin = Infinity, stepMax = 0;
  const phases = emptyPhases();
  let conditionReports = 0, samplingReports = 0, finalDecodeReports = 0;
  let conditionMs = 0, samplingMs = 0, finalDecodeMs = 0, previewMs = 0, previewReports = 0, stepPreviewMs = 0;
  let diffusionGraphs = 0, textGraphs = 0, vaeGraphs = 0, otherGraphs = 0;
  const placementTotal = emptyPlacement();
  let placementWindow = emptyPlacement();
  function report({ metric, fields }: { metric: string, fields: ImageDiagnosticInput['fields'] }): void {
    if (!enabled || closed) return;
    try {
      emit({ event: 'native', stage: 'generation', message: undefined, fields: { metric, perfVersion: 1, ...fields } });
    } catch { /* observational */ }
  }
  function reportPlacement({ metric, counts }: { metric: 'graph-placement-window' | 'graph-placement-summary', counts: ReturnType<typeof emptyPlacement> }): void {
    report({
      metric,
      fields: {
        phase,
        step,
        ...counts,
        uninspectedBf16WeightMatmuls: counts.bf16WeightMatmuls - counts.inspectedBf16WeightMatmuls,
        coverage: counts.invalidReports || counts.bf16WeightMatmuls !== counts.inspectedBf16WeightMatmuls ? 'partial' : counts.allocationReports ? 'observed-allocations' : 'not-observed',
        observation: 'allocation-metadata',
        weightBytesMeaning: 'operand-uses-not-unique-residency',
        actualTransfersMeasured: false,
      },
    });
  }
  function flushPlacement(): void {
    if (!placementWindow.allocationReports && !placementWindow.invalidReports) return;
    reportPlacement({ metric: 'graph-placement-window', counts: placementWindow });
    placementWindow = emptyPlacement();
  }
  function setPhase({ next }: { next: PerformancePhase }): void {
    if (!enabled || closed || next === phase) return;
    const time = now(), ms = Math.max(0, time - phaseStart);
    phases[phase] += ms;
    report({ metric: 'phase-wall', fields: { phase, milliseconds: ms, startMs: phaseStart - began, endMs: time - began } });
    flushPlacement();
    checkpoint({
      point: {
        phase: next,
        step: (() => {
          switch (next) {
          case 'sampling': return step;
          case 'runtime': case 'model-header': case 'model-load': case 'prepare': case 'conditioning': case 'decoding': case 'encoding': case 'cleanup': return 0;
          default: { const exhaustive: never = next; throw new Error(String(exhaustive)); }
          }
        })(),
        reason: 'phase',
      },
    });
    phase = next; phaseStart = time;
  }
  return {
    settings(): void {
      if (!enabled || closed) return;
      const p = request.parameters;
      // Exact approved flag only; do not parse/export arbitrary model arguments.
      const arg = p.modelArguments.trim();
      const cacheFlag = /^qwen_image_2_1_prefix_cache=(true|false)$/.exec(arg)?.[1];
      report({
        metric: 'run-settings',
        fields: {
          appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.slice(0, 128) : 'not-available',
          previewStartStep: request.preview.startStep,
          previewMaxEdge: request.preview.maxEdge,
          conditioningCacheSize: p.conditioningCacheSize,
          qwenVaePolicy: p.qwenVaePolicy,
          distilledGuidance: p.distilledGuidance,
          bf16WeightType: p.bf16WeightType,
          modelArgumentsPresent: !!arg,
          qwenPrefixCacheRequested: cacheFlag ?? (arg ? 'not-disclosed' : 'native-default'),
          modelBytes: request.models.reduce((n, model) => n + model.file.size + (model.companions ?? []).reduce((a, c) => a + c.file.size, 0), 0),
          gpuTimestampMeasured: false,
          semanticBackendTrace: false,
          backendPlacementObservation: 'native-allocation-summary-when-available',
          previewNativeTime: 'rounded-native-log-when-available',
        },
      });
      if (typeof navigator !== 'undefined') {
        const match = /(?:Chrome|Chromium|Firefox)\/(\d+(?:\.\d+){0,3})/.exec(navigator.userAgent ?? '');
        report({
          metric: 'run-environment',
          fields: {
            browserVersion: match?.[0] ?? 'not-disclosed',
            hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
          },
        });
      }
    },
    phase: setPhase,
    native({ signal }: { signal: NativePerformanceSignal }): void {
      if (!enabled || closed) return;
      switch (signal.kind) {
      case 'conditioning': setPhase({ next: 'conditioning' }); return;
      case 'sampling-progress': break;
      default: { const exhaustive: never = signal; throw new Error(String(exhaustive)); }
      }
      const { step: next, steps } = signal;
      if (!Number.isInteger(next) || steps !== request.parameters.steps || next < 0 || next > steps) return;
      if (next === 0 && stepStart === undefined) {
        setPhase({ next: 'sampling' }); stepStart = now(); return;
      }
      if (stepStart === undefined || next <= step) return;
      const time = now(), ms = Math.max(0, time - stepStart);
      stepSum += ms; stepMin = Math.min(stepMin, ms); stepMax = Math.max(stepMax, ms); stepsSeen++;
      report({
        metric: 'step-wall',
        fields: {
          step: next,
          previousStep: step,
          steps,
          milliseconds: ms,
          includesPreviewWork: true,
          previewReportedMs: previewMs - stepPreviewMs,
        },
      });
      flushPlacement();
      checkpoint({ point: { phase: 'sampling', step: next, reason: 'completed-step' } });
      step = next; stepStart = time; stepPreviewMs = previewMs;
    },
    log({ message }: { message: string }): void {
      if (!enabled || closed || message.length > 2048) return;
      // Parse before the raw-log rate limiter. An allocation snapshot reports
      // scheduling and original weight operands, not completed kernels or real
      // readbacks; compare its windows with independent WebGPU API measurements.
      const placement = parsePlacement({ message });
      if (placement !== undefined) {
        if (placement === 'invalid') {
          placementTotal.invalidReports++; placementWindow.invalidReports++;
        } else {
          for (const key of Object.keys(placement) as (keyof typeof placement)[]) {
            placementTotal[key] += placement[key]; placementWindow[key] += placement[key];
          }
        }
        return;
      }
      // Registration counts each converted parameter once. Preserve this small
      // report even if raw native logs are throttled during model loading.
      const conversion = parseWeightConversion({ message });
      if (conversion !== undefined) {
        report({ metric: 'weight-conversion', fields: { ...conversion, weightBytesMeaning: 'unique-parameter-payload-not-allocation-or-peak' } });
        return;
      }
      // Anchored, pinned diagnostic formats. Changes in upstream remain missing
      // information, never guessed timings or disclosure of prompt/model text.
      let value: RegExpExecArray | null;
      if ((value = /^image\.cpp:\d+\s+- get_learned_condition completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        conditionMs += Number(value[1]) * 1000; conditionReports++;
      }
      if ((value = /^image\.cpp:\d+\s+- sampling completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        samplingMs += Number(value[1]) * 1000; samplingReports++;
      }
      if ((value = /^vae\.hpp:\d+\s+- computing vae decode graph completed, taking (\d+(?:\.\d+)?)s\s*$/.exec(message))) {
        switch (phase) {
        case 'sampling': previewMs += Number(value[1]) * 1000; previewReports++; break;
        case 'decoding': finalDecodeMs += Number(value[1]) * 1000; finalDecodeReports++; break;
        case 'runtime': case 'model-header': case 'model-load': case 'prepare': case 'conditioning': case 'encoding': case 'cleanup': break;
        default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
        }
      }
      if ((value = /^ggml_runner\.cpp:\d+\s+- ([a-z0-9_]+) executing segment \d+\/\d+: graph\s*$/.exec(message))) {
        const name = value[1];
        if (name === 'z_image' || name === 'qwen_image_2_1') diffusionGraphs++;
        else if (name === 'qwen3' || name === 'qwen3vl') textGraphs++;
        else if (name === 'vae' || name === 'wan_vae') vaeGraphs++;
        else otherGraphs++;
      }
    },
    preview({ fields }: { fields: ImageDiagnosticInput['fields'] }): void {
      report({ metric: 'preview-output', fields });
    },
    finish({ outcome }: { outcome: MeasurementOutcome }): void {
      if (!enabled || closed) return;
      const time = now();
      phases[phase] += Math.max(0, time - phaseStart);
      const partialStepWallMs = phase === 'sampling' && stepStart !== undefined && step < request.parameters.steps ? Math.max(0, time - stepStart) : 0;
      flushPlacement();
      // Older cores or retained runs without allocations are unobserved, not
      // proof that BF16/CPU work was absent. Re-emit coverage for every run.
      reportPlacement({ metric: 'graph-placement-summary', counts: placementTotal });
      report({
        metric: 'run-wall',
        fields: {
          outcome,
          milliseconds: Math.max(0, time - began),
          ...phases,
          partialStepWallMs,
          completedStepIntervals: stepsSeen,
          stepWallSumMs: stepSum,
          stepMinMs: stepsSeen ? stepMin : 0,
          stepMaxMs: stepMax,
          nativeConditionMs: conditionMs,
          nativeConditionReports: conditionReports,
          nativeSamplingMs: samplingMs,
          nativeSamplingReports: samplingReports,
          nativeFinalDecodeMs: finalDecodeMs,
          nativeFinalDecodeReports: finalDecodeReports,
          nativePreviewDecodeMs: previewMs,
          nativePreviewDecodeReports: previewReports,
          diffusionGraphStarts: diffusionGraphs,
          textGraphStarts: textGraphs,
          vaeGraphStarts: vaeGraphs,
          otherGraphStarts: otherGraphs,
          nativeTimesOverlapWall: true,
          nativeTimesAreRounded: true,
        },
      });
      closed = true;
    },
  };
}
export const TEST_ONLY = {
};
