import { expect, it } from 'vitest';
import { createLiveSpeechFixture } from './speech-controller.test-support';
import { createInvestigationRecord } from './investigation-record';
import { createInvestigationPlan } from './investigation-plan';

it('projects a public plan without copying private prompt bodies or live File objects', async () => {
  await using speech = createLiveSpeechFixture();
  const file = new File(['input bytes'], 'source.wav', { type: 'audio/wav' });
  const modelFile = new File(['model bytes'], 'model.gguf');
  await speech.controller.load({ file: modelFile });
  const model = speech.controller.getState().runtime.model;
  if (!model) {
    throw new Error('Expected a loaded fixture model');
  }
  using capture = {
    recorder: createInvestigationRecord({ changed() {} }),
    [Symbol.dispose]() {
      this.recorder.clear();
    },
  };
  const recorder = capture.recorder;
  recorder.prepareRun({ task: 'dialogue', modelId: 'model/id', modelFile, model, file, recording: false, language: 'ja', seed: 0, maxSeconds: 120, inputPacing: 'fast', instructions: 'private prompt body' });
  const snapshot = recorder.snapshot();
  if (!snapshot) {
    throw new Error('Expected a prepared operation');
  }
  const plan = createInvestigationPlan({ operation: snapshot.operation, trials: [{ id: 'trial-1', inputLevel: { status: 'observed', value: { kind: 'gain', gain: 4 }, source: 'UI acceptance' } }], tailSeconds: { status: 'observed', value: 5, source: 'UI acceptance' } });
  expect(plan.privateInputs).toEqual({ persona: 'set', instructions: 'unset', name: 'unset' });
  expect(plan.source).toMatchObject({ kind: 'file', name: file.name, bytes: file.size });
  expect(plan.requested.seed).toMatchObject({ status: 'observed', value: 0 });
  expect(JSON.stringify(plan)).not.toContain('private prompt body');
  expect(JSON.stringify(plan)).not.toContain('input bytes');
  expect(JSON.stringify(plan)).not.toContain('model bytes');
  expect(snapshot.operation.privateInputs.persona).toBe('private prompt body');
});
