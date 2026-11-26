// @vitest-environment node
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createBlobZipSource, createWebZipCompressionCodec, StreamingZipReader } from '@/utils/zip-stream';
import { createSpeechInvestigationCollection } from './collection';
import { createSpeechInvestigationArchive } from './archive';
import { investigationFixture, observed, planFromSnapshot, waveBytes } from './investigation.test-support';
import { speechInvestigationCollectionLimits as limits, type SpeechInvestigationSnapshot } from './types';

function trialSnapshot({ source, text, status }: { source: Blob, text: string, status: SpeechInvestigationSnapshot['status'] }): SpeechInvestigationSnapshot {
  const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
  operation.result.text = text;
  run.setAudio({ role: 'source', audio: { status: 'retained', blob: source, format: 'wav', description: 'Common original WAV' } });
  run.setAudio({ role: 'input', audio: { status: 'retained', blob: new Blob([waveBytes()]), format: 'wav', description: 'Adjusted client-accepted PCM; may remain queued' } });
  run.setAudio({ role: 'output', audio: { status: 'retained', blob: new Blob([waveBytes()]), format: 'wav', description: 'Generated PCM before playback' } });
  if (status === 'in_progress') {
    return run.checkpoint({ environment, operation })!;
  }
  run.finish({ status, environment, operation });
  return recorder.snapshot()!;
}

function fixture({ count }: { count: number }) {
  const source = new Blob([waveBytes()]);
  const first = trialSnapshot({ source, text: 'first response', status: 'completed' });
  const plan = planFromSnapshot({ snapshot: first, trials: Array.from({ length: count }, (_, index) => ({ id: `level-${index + 1}`, inputLevel: observed({ value: { kind: 'gain' as const, gain: index === 0 ? 0.5 : index } }) })) });
  const collection = createSpeechInvestigationCollection({ plan, sourceAudio: { status: 'retained', blob: source, format: 'wav', description: 'Fixed original audio; unchanged between trials' } });
  return { source, first, plan, collection };
}

describe('bounded speech investigation collection', () => {
  it('retains sequential snapshots and immutable checkpoints while preserving common source and unique run IDs', () => {
    const { source, first, collection } = fixture({ count: 2 });
    const before = collection.snapshot({ active: undefined })!;
    expect(collection.startTrial({ trialId: 'level-2' })).toBe(false);
    expect(collection.startTrial({ trialId: 'level-1' })).toBe(true);
    const active = trialSnapshot({ source, text: 'partial', status: 'in_progress' });
    const checkpoint = collection.snapshot({ active: { trialId: 'level-1', snapshot: active } })!;
    expect(checkpoint.trials[0]).toMatchObject({ status: 'in_progress', snapshot: { id: active.id } });
    expect(before.trials[0]?.status).toBe('not_run');
    expect(collection.completeTrial({ trialId: 'level-1', snapshot: first, retention: 'available' })?.kind).toBe('accepted');
    expect(collection.startTrial({ trialId: 'level-2' })).toBe(true);
    const second = trialSnapshot({ source, text: 'second response', status: 'completed' });
    const accepted = collection.completeTrial({ trialId: 'level-2', snapshot: second, retention: 'available' })!;
    expect(accepted.trial.snapshot?.audio.output).toMatchObject({ status: 'retained', blob: second.audio.output.status === 'retained' ? second.audio.output.blob : undefined });
    const snapshot = collection.snapshot({ active: undefined })!;
    expect(snapshot.status).toBe('completed');
    expect(snapshot.capture.audioBytes).toBe(source.size + 4 * 50);
    expect(snapshot.trials.map(trial => trial.status)).toEqual(['completed', 'completed']);
    expect(first.id).not.toBe(second.id);
    expect(checkpoint.trials[0]).toMatchObject({ status: 'in_progress', snapshot: { operation: { result: { text: 'partial' } } } });
    collection.clear();
    expect(collection.snapshot({ active: undefined })).toBeUndefined();
    expect(collection.remainingAudioBytes()).toBe(0);
    expect(snapshot.sourceAudio).toMatchObject({ status: 'retained', blob: source });
    expect(collection.completeTrial({ trialId: 'level-2', snapshot: second, retention: 'available' })).toBeUndefined();
  });

  it('keeps an independent load-only snapshot and never creates generation trials', async () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'recognition' });
    operation.source = { kind: 'unset', reason: 'Model loading has no input audio' };
    operation.result.text = '';
    run.finish({ status: 'completed', environment, operation });
    const load = recorder.snapshot()!;
    const collection = createSpeechInvestigationCollection({ plan: planFromSnapshot({ snapshot: load, trials: [] }), sourceAudio: { status: 'not_applicable', reason: 'Model-load attempt only' } });
    expect(collection.setLoad({ snapshot: load })).toBe(true);
    const snapshot = collection.snapshot({ active: undefined })!;
    expect(snapshot.status).toBe('completed');
    expect(snapshot.trials).toEqual([]);
    expect(snapshot.load?.id).toBe(load.id);
    const archive = createSpeechInvestigationArchive({ collection: snapshot, includeInputAudio: 'on', includeInputText: 'off', signal: new AbortController().signal });
    const zip = await JSZip.loadAsync(await new Response(archive.stream).arrayBuffer());
    expect(zip.file('load/operation.json')).toBeTruthy();
    expect(Object.keys(zip.files).some(path => path.startsWith('trials/') || path.startsWith('source/'))).toBe(false);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest).toMatchObject({ version: 2, trials: [], load: { runId: load.id, status: 'completed' } });
  });

  it('accepts the final active failure after cancellation and leaves every later trial not_run with a reason', () => {
    const { source, collection } = fixture({ count: 3 });
    collection.startTrial({ trialId: 'level-1' });
    collection.stop({ status: 'cancelled', reason: 'User cancelled the comparison' });
    const failed = trialSnapshot({ source, text: 'partial before native failure', status: 'failed' });
    expect(collection.completeTrial({ trialId: 'level-1', snapshot: failed, retention: 'available' })?.kind).toBe('accepted');
    const snapshot = collection.snapshot({ active: undefined })!;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.trials[0]).toMatchObject({ status: 'failed', snapshot: { operation: { result: { text: 'partial before native failure' } } } });
    expect(snapshot.trials.slice(1)).toEqual([expect.objectContaining({ status: 'not_run', reason: 'User cancelled the comparison' }), expect.objectContaining({ status: 'not_run', reason: 'User cancelled the comparison' })]);
    expect(collection.startTrial({ trialId: 'level-2' })).toBe(false);
  });

  it('keeps native completion separate from partial capture and rejects over-budget audio with explicit reasons', () => {
    const { source, first, plan } = fixture({ count: 2 });
    const block = new Blob([new Uint8Array(1024 * 1024)]);
    const largeSource = new Blob([...Array.from({ length: 63 }, () => block), block.slice(0, 1024 * 1024 - 100)]);
    const collection = createSpeechInvestigationCollection({ plan, sourceAudio: { status: 'retained', blob: largeSource, format: 'bin', description: 'Source budget fixture' } });
    expect(collection.remainingAudioBytes()).toBe(100);
    const snapshot = { ...first, audio: { source: { status: 'retained' as const, blob: largeSource, format: 'bin' as const, description: 'same source' }, input: { status: 'retained' as const, blob: new Blob([new Uint8Array(80)]), format: 'wav' as const, description: 'Accepted input' }, output: { status: 'retained' as const, blob: new Blob([new Uint8Array(80)]), format: 'wav' as const, description: 'Generated output' } } };
    collection.startTrial({ trialId: 'level-1' });
    const accepted = collection.completeTrial({ trialId: 'level-1', snapshot, retention: 'available' })!;
    expect(accepted.kind).toBe('limit');
    expect(accepted.trial).toMatchObject({ status: 'completed', capture: { status: 'partial', reason: expect.stringContaining('audio budget') }, snapshot: { status: 'completed', audio: { input: { status: 'unavailable' }, output: { status: 'retained' } } } });
    expect(collection.snapshot({ active: undefined })).toMatchObject({ status: 'partial', capture: { audioBytes: limits.audioBytes - 20 }, trials: [expect.anything(), expect.objectContaining({ status: 'not_run', reason: expect.stringContaining('audio budget') })] });
    expect(collection.remainingAudioBytes()).toBe(20);
    expect(source.size).toBe(50);
  });

  it('stops remaining trials when the active runtime retained only a prefix', () => {
    const { collection, first } = fixture({ count: 2 });
    collection.startTrial({ trialId: 'level-1' });
    const accepted = collection.completeTrial({ trialId: 'level-1', snapshot: { ...first, status: 'partial' }, retention: 'limit' })!;
    expect(accepted.kind).toBe('limit');
    expect(accepted.trial.snapshot?.audio.output.status).toBe('retained');
    expect(collection.snapshot({ active: undefined })).toMatchObject({ status: 'partial', trials: [expect.objectContaining({ status: 'partial', capture: { status: 'partial', reason: expect.stringContaining('retained-audio limit') } }), expect.objectContaining({ status: 'not_run' })] });
  });

  it('bounds metadata, rejects changed common source and marks unavailable records without fake completion evidence', () => {
    const { collection, first } = fixture({ count: 2 });
    collection.startTrial({ trialId: 'level-1' });
    const excessive = { ...first, operation: { ...first.operation, processing: observed({ value: { excessive: 'x'.repeat(limits.metadataBytes) } }) } };
    const admission = collection.completeTrial({ trialId: 'level-1', snapshot: excessive, retention: 'available' })!;
    expect(admission.kind).toBe('limit');
    expect(admission.trial).toMatchObject({ status: 'completed', snapshot: undefined, capture: { status: 'partial', reason: expect.stringContaining('metadata limit') } });
    expect(collection.snapshot({ active: undefined })!.capture.metadataBytes).toBeLessThan(limits.metadataBytes);
    const second = fixture({ count: 1 });
    second.collection.startTrial({ trialId: 'level-1' });
    const differentSource = trialSnapshot({ source: new Blob([waveBytes()]), text: 'different File identity', status: 'completed' });
    expect(second.collection.completeTrial({ trialId: 'level-1', snapshot: differentSource, retention: 'available' })).toMatchObject({ kind: 'limit', trial: { capture: { reason: 'Trial source differs from the fixed common source File' } } });
  });

  it('freezes all six planned input levels and explicitly excludes private bodies from plan JSON', async () => {
    const { plan, source } = fixture({ count: 1 });
    const variants = [0.5, 1, 2, 4, 8].map(gain => ({ id: `gain-${gain}`, inputLevel: observed({ value: { kind: 'gain' as const, gain } }) }));
    const peak = { kind: 'peak' as const, targetPeak: 0.8, instructions: 'FORBIDDEN_VARIANT_BODY' };
    const extended = { ...plan, requested: { ...plan.requested, persona: 'FORBIDDEN_PLAN_BODY' }, trials: [...variants, { id: 'peak-80', inputLevel: observed({ value: peak }) }] };
    const collection = createSpeechInvestigationCollection({ plan: extended, sourceAudio: { status: 'retained', blob: source, format: 'wav', description: 'Common source' } });
    peak.targetPeak = 0.5;
    const snapshot = collection.snapshot({ active: undefined })!;
    const archive = createSpeechInvestigationArchive({ collection: snapshot, includeInputAudio: 'off', includeInputText: 'off', signal: new AbortController().signal });
    const zip = await JSZip.loadAsync(await new Response(archive.stream).arrayBuffer());
    const text = await zip.file('plan.json')!.async('string');
    expect(text).not.toContain('FORBIDDEN_PLAN_BODY');
    expect(text).not.toContain('FORBIDDEN_VARIANT_BODY');
    expect(JSON.parse(text).trials.at(-1).inputLevel.value).toEqual({ kind: 'peak', targetPeak: 0.8 });
    expect(snapshot.trials).toHaveLength(6);
    expect(snapshot.trials.every(trial => trial.status === 'not_run')).toBe(true);
    expect(() => createSpeechInvestigationCollection({ plan: { ...plan, trials: [...extended.trials, { id: 'overflow', inputLevel: observed({ value: { kind: 'gain' as const, gain: 1 } }) }] }, sourceAudio: { status: 'unavailable', reason: 'No source' } })).toThrow(/trial plan/);
    expect(() => createSpeechInvestigationCollection({ plan: { ...plan, trials: [extended.trials[0]!, extended.trials[0]!] }, sourceAudio: { status: 'unavailable', reason: 'No source' } })).toThrow(/trial plan/);
  });

  it('writes multiple full trial records, original input once and body/audio opt-ins without sharing private settings by default', async () => {
    const { source, first, collection } = fixture({ count: 2 });
    collection.startTrial({ trialId: 'level-1' });
    collection.completeTrial({ trialId: 'level-1', snapshot: first, retention: 'available' });
    const second = trialSnapshot({ source, text: 'second volume response', status: 'completed' });
    collection.startTrial({ trialId: 'level-2' });
    collection.completeTrial({ trialId: 'level-2', snapshot: second, retention: 'available' });
    const snapshot = collection.snapshot({ active: undefined })!;
    for (const include of ['off', 'on'] as const) {
      const archive = createSpeechInvestigationArchive({ collection: snapshot, includeInputAudio: include, includeInputText: include, signal: new AbortController().signal });
      const blob = await new Response(archive.stream).blob();
      const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec: createWebZipCompressionCodec() });
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          await reader.close();
        },
      };
      for await (const entry of reader.entries()) {
        expect(entry.compression).toBe('deflate');
      }
      const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
      expect(manifest).toMatchObject({ version: 2, collection: { status: 'completed' }, trials: [{ id: 'level-1', status: 'completed', record: { runId: first.id } }, { id: 'level-2', status: 'completed', record: { runId: second.id } }] });
      const planText = await zip.file('plan.json')!.async('string');
      expect(planText).not.toContain('private persona');
      expect(planText).not.toContain('private instructions');
      expect(JSON.parse(planText).trials.map((trial: { inputLevel: { value: { gain: number } } }) => trial.inputLevel.value.gain)).toEqual([0.5, 1]);
      expect(Object.keys(zip.files).filter(path => path.startsWith('source/'))).toEqual(include === 'on' ? ['source/audio.wav'] : []);
      for (const [index, text] of ['first response', 'second volume response'].entries()) {
        const prefix = `trials/00${index + 1}-level-${index + 1}/`;
        const operation = JSON.parse(await zip.file(prefix + 'operation.json')!.async('string'));
        expect(operation.result.text).toBe(text);
        expect(operation.requested.seed.value).toBe(0);
        expect(await zip.file(prefix + 'audio/output.wav')!.async('uint8array')).toEqual(waveBytes());
        expect(zip.file(prefix + 'audio/input.wav') !== null).toBe(include === 'on');
        expect(zip.file(prefix + 'input.json') !== null).toBe(include === 'on');
      }
    }
  });
});
