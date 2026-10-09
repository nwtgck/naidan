import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from '@/utils/zip-stream/memory';
import { StreamingZipWriter, createWebZipCompressionCodec } from '@/utils/zip-stream';
import { performanceProtocol, snapshotSchema, type PerformanceSnapshot } from './types';
import { summarizePerformance, performanceFindings, trialRates } from './summary';

const readme = `# Naidan llama.cpp browser performance / ${performanceProtocol}

## Start here
- plan.json: exact models, order, settings, per-call output limits, and fixtures.
- findings.json: same-workload before/after comparisons; observations, not causes.
- summary.json: uninstrumented measurements partitioned by effective conditions.
- trials.jsonl: all attempts, timings, exclusions, diagnostics, and partial failures.
- backend-placement.json: operation metadata from separate diagnostic calls.
- outputs/: actual input, output, and reasoning for each attempt.

## What changed in this protocol
The default is one block: initial short (up to 8 output tokens), short before
(up to 64), its real continuation (up to 16), long input (up to 8), and the
same fresh short input after (up to 64). The initial call doubles as warm-up;
there is no additional full-length warm-up or regenerated continuation parent.
An optional final diagnostic generates up to 2 tokens. Thus the default is
6 calls with an output ceiling of 162 tokens, rather than 15 calls of 128 each.
The short before/after results stay separate. The first long input can include
first-use graph/pipeline work; it is NOT a warmed-prefill claim. Increase blocks
only when a specific comparison needs confirmation, not to hide chronological drift.
The input is English. Results are not interchangeable with standard-text-v1
(Japanese) or standard-text-en-v2 (a different schedule and output budget).

## Operation diagnostic: capabilities and limitations
The diagnostic uses the public native evaluation callback, reads tensor metadata
only, and never requests node completion or tensor values. Upstream scheduling
still synchronizes backend splits when that callback is present. Therefore this
call is marked instrumented and excluded from all normal speed aggregates.
Types, operation descriptions, graph-compute flags, shapes, first two source shapes, destination-buffer storage, and WebGPU
operation-support queries are collected. This is NOT an exact execution-backend
trace: a host buffer does not by itself prove CPU fallback, an unsupported op is
not proof of its runtime share, and optimized/fused graph nodes may not correspond
to separate dispatches. Views are identified separately. Node counts are not time.
GPU (Graphics Processing Unit) kernel durations, exact CPU (Central Processing Unit)/GPU utilization, and transfer/synchronization
breakdowns are NOT collected. Missing fields are not replaced with zero.
A separate profiling build is needed for upstream GPU timestamp instrumentation;
profiling changes dispatch batching and must not replace the ordinary runtime.
The capability field identifies which metadata reader was actually available.
Legacy JSPI (JavaScript Promise Integration) artifacts return Promises even for
non-suspending getters. Without the versioned synchronous callback bindings,
only safe tensor layout fields are read: buffer placement and WebGPU support
are explicitly unavailable, not CPU fallback. Rebuild bicore with the separate
callback-metadata binding patch to obtain those additional leaf observations.
Collection is bounded; inspect droppedNodes and errors before drawing conclusions.
placement-layout-only, placement-missing and placement-incomplete warnings are
not erased by a successful inference. A completed run is not proof of full GPU
profiling. Failure summaries retain a classified failureKind and stage, not raw
native messages or exception stacks.
No callback or node inspection is installed for normal unmeasured chat. A context
created for diagnostics is freed before returning to an ordinary context; loaded
weights can be retained. The final model cleanup releases the diagnostic context.

## Interpreting timings
The initial call starts after native runtime release, not after clearing OS or
browser caches. Fresh requests reset the sequence; reusedTokens must be zero.
Continuation uses the actual parent output, even if it reached the output cap.
An incomplete-parent warning describes this condition; it does not erase the data.
Reasoning-only parents are not fabricated into complete visible answers.
Main-thread receipt is not display completion. Native stage durations are elapsed
wall time, not GPU kernel time. Overlapped decode/delivery must not be decomposed
into independent CPU and GPU time by subtraction.
Generation rate = (non-EOG samples - 1) / seconds between first and last sample.
EOG means End Of Generation. Sample counts are not chunk counts or decode counts.
Input rate uses actually decoded tokens and excludes reused tokens.
sampleWindows groups up to 16 already-timestamped samples per window, adding no
per-token clock reads. Each window's rate uses its own first/last sample interval;
partial windows and gaps between windows must not be silently averaged together.
memoryObservation describes WebAssembly linear-heap capacity and retained native
checkpoint bytes. Neither is GPU allocation, resident physical memory, or pressure.
checkpoint.phases separates boundary tokenization, state sizing/allocation, readback,
restore upload, trim and validation. These child wall times overlap the existing
cache-checkpoint stage; never add them to the stage sum or label them GPU kernel
time. captureAttempts/restoreAttempts count attempts, not successful copies;
retainedRestoredCaptures counts identical restored snapshots not copied again.
Checkpoint elapsed time can include device-to-host transfer and synchronization;
it must not be labelled CPU arithmetic time.

## Provenance and failure handling
Inputs and results live in memory; no chat history is read or written. Export
occurs only when the user presses Save ZIP, never automatically after completion.
execution.json records runner duration separately from export time, including
visibility waits, inventory checks, model acquisition/release and bounded visibility
changes. These intervals are orchestration wall time, not CPU/GPU kernel time.
Trial startedMs is relative to runner start. Manual delay before Save ZIP is not
inference time; elapsed time between trials must not be attributed to the GPU.
Export happens only after measuring; there is no ZIP compression during generation.
Hidden-page attempts remain recorded but are excluded; the next call waits for
visibility. Cancellation and failed attempts retain available partial output.
Model IDs, names, sizes, and import timestamps are identifiers, not content hashes.
runtimeBuild records the supplied bicore source revision and original asset
SHA-256 digests (Secure Hash Algorithm, 256 bits), not a rehash of transformed
JavaScript or the actual loaded bytes. Record the Naidan commit and environment
conditions in plan.notes; appVersion alone cannot identify a development patch.
runtimeAssetBaseURL is the asset location, not a model download URL.
preparationEvents contains up to 64 existing low-frequency observations; their
observedMs is relative to request acceptance, not the event's own elapsedMs.
modelReads uses existing byte/read counters, without extra per-read clock calls.
lastProgress survives forced termination when its notification was received.
The archive does not include model weights, account credentials, or saved chats.
`;
function csvCell({ value }: { value: string | number | undefined }): string {
  let text = value === undefined ? '' : String(value);
  // Metadata can be arbitrary text. Do not turn it into a spreadsheet formula.
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function performanceArchive({ snapshot: input }: { snapshot: PerformanceSnapshot }): Promise<Blob> {
  const snapshot = snapshotSchema.parse(input);
  switch (snapshot.status) {
  case 'running': throw new Error('Stop measurement before exporting');
  case 'completed': case 'cancelled': break;
  default: { const exhaustive: never = snapshot.status; throw new Error(String(exhaustive)); }
  }
  const output = createReadableZipOutput({ highWaterMarkBytes: 256 * 1024 });
  const directory = createMemoryZipCentralDirectoryStore();
  const writer = new StreamingZipWriter({ output: output.sink, centralDirectoryStore: directory, compressionCodec: createWebZipCompressionCodec() });
  const modifiedAt = new Date();
  const add = async ({ name, text }: { name: string, text: string }) => writer.addFile({ name, modifiedAt, compression: 'store', stream: new Blob([text]).stream() });
  const json = ({ value }: { value: unknown }) => JSON.stringify(value, undefined, 2) + '\n';
  const completed = (async () => {
    try {
      await add({ name: 'README.md', text: readme });
      await add({
        name: 'manifest.json',
        text: json({
          value: {
            version: 1,
            id: snapshot.plan.id,
            status: snapshot.status,
            modelErrors: snapshot.modelErrors,
            exportedAt: modifiedAt.toISOString(),
          },
        }),
      });
      await add({ name: 'execution.json', text: json({ value: snapshot.execution ?? null }) });
      await add({ name: 'plan.json', text: json({ value: snapshot.plan }) });
      await add({ name: 'environment.json', text: json({ value: snapshot.environment }) });
      await add({ name: 'summary.json', text: json({ value: summarizePerformance({ snapshot }) }) });
      await add({ name: 'findings.json', text: json({ value: performanceFindings({ snapshot }) }) });
      await add({ name: 'backend-placement.json', text: json({ value: snapshot.trials.filter(trial => snapshot.plan.steps.find(step => step.id === trial.stepId)?.scenario === 'placement').map(trial => ({ attemptId: trial.id, modelIndex: trial.modelIndex, status: trial.status, warnings: trial.warnings, diagnostic: trial.summary?.performance?.backendCensus, failureKind: trial.summary?.failureKind, stage: trial.summary?.stage, error: trial.error })) }) });
      await add({ name: 'trials.jsonl', text: snapshot.trials.map(({ input: _input, output: _output, partialText: _text, partialReasoning: _reasoning, ...record }) => JSON.stringify(record)).join('\n') + '\n' });
      const rows: (string | number | undefined)[][] = [['attempt', 'model', 'scenario', 'position', 'output_limit', 'role', 'status', 'warnings', 'exclusion', 'elapsed_ms', 'first_received_ms', 'first_text_ms', 'first_reasoning_ms', 'prefill_tokens_s', 'generation_tokens_s', 'prompt_tokens', 'reused_tokens', 'context_tokens', 'batch_tokens', 'finish_reason', 'parent_finish_reason', 'last_phase', 'last_progress_ms', 'error']];
      for (const trial of snapshot.trials) {
        const step = snapshot.plan.steps.find(step => step.id === trial.stepId);
        const metrics = trial.summary?.performance, rates = trialRates({ trial });
        rows.push([trial.id, snapshot.plan.models[trial.modelIndex]?.name, step?.scenario, step?.position, step?.maxTokens, step?.role, trial.status,
          trial.warnings.join(';'), trial.exclusion.join(';'), trial.elapsedMs, trial.firstReceivedMs, trial.firstTextMs, trial.firstReasoningMs,
          trial.exclusion.includes('instrumented') ? undefined : rates.prefillTokensPerSecond, trial.exclusion.includes('instrumented') ? undefined : rates.generationTokensPerSecond, metrics?.promptTokens, metrics?.reusedTokens,
          metrics?.contextTokens, metrics?.prefillBatchTokens, trial.output?.finishReason,
          step?.dependsOn === undefined ? undefined : snapshot.trials.find(parent => parent.stepId === step.dependsOn)?.output?.finishReason, trial.lastProgress?.phase, trial.lastProgressMs, trial.error]);
        await add({ name: `outputs/${trial.id}.json`, text: json({ value: { input: trial.input, output: trial.output, partialText: trial.partialText, partialReasoning: trial.partialReasoning } }) });
      }
      await add({ name: 'summary.csv', text: rows.map(row => row.map(value => csvCell({ value })).join(',')).join('\r\n') + '\r\n' });
      await writer.finalize(); await output.close();
    } catch (error) {
      await output.abort({ reason: error }).catch(() => {}); throw error;
    } finally {
      await directory.dispose();
    }
  })();
  void completed.catch(() => {});
  const reader = output.stream.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024 ** 2) throw new Error('Measurement archive exceeds 128 MiB');
      parts.push(Uint8Array.from(part.value));
    }
    await completed;
    return new Blob(parts, { type: 'application/zip' });
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
export const TEST_ONLY = {
};
