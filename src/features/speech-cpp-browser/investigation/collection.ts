import { nanoid } from 'nanoid';
import { speechInvestigationCollectionLimits as limits, type SpeechInvestigationAudio, type SpeechInvestigationCollectionSnapshot, type SpeechInvestigationPlan, type SpeechInvestigationSnapshot, type SpeechInvestigationTrial } from './types';

function freeze({ value }: { value: unknown }): void {
  if (value === undefined || value === null || typeof value !== 'object' || value instanceof Blob || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freeze({ value: child });
  }
}

function audioMetadata({ audio }: { audio: SpeechInvestigationAudio }) {
  switch (audio.status) {
  case 'retained': return { status: audio.status, bytes: audio.blob.size, format: audio.format, description: audio.description };
  case 'unavailable': case 'not_applicable': return audio;
  default: {
    const exhaustive: never = audio;
    throw new Error(String(exhaustive));
  }
  }
}

function bytes({ value }: { value: unknown }): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function audioBytes({ audio }: { audio: SpeechInvestigationAudio }): number {
  switch (audio.status) {
  case 'retained': return audio.blob.size;
  case 'unavailable': case 'not_applicable': return 0;
  default: {
    const exhaustive: never = audio;
    throw new Error(String(exhaustive));
  }
  }
}

function snapshotMetadata({ snapshot }: { snapshot: SpeechInvestigationSnapshot }) {
  const { audio, ...metadata } = snapshot;
  return { ...metadata, audio: { source: audioMetadata({ audio: audio.source }), input: audioMetadata({ audio: audio.input }), output: audioMetadata({ audio: audio.output }) } };
}

type RecordedTrial = Exclude<SpeechInvestigationTrial, { status: 'not_run' }>;
type State = {
  id: string, createdAt: string, plan: SpeechInvestigationPlan, sourceAudio: SpeechInvestigationAudio,
  load: SpeechInvestigationSnapshot | undefined, trials: SpeechInvestigationTrial[],
  active: string | undefined, stopped: 'partial' | 'cancelled' | 'failed' | undefined, limitReason: string | undefined,
};

function retainedBytes({ state }: { state: State }): number {
  let total = audioBytes({ audio: state.sourceAudio });
  for (const trial of state.trials) {
    if (trial.status !== 'not_run' && trial.snapshot !== undefined) {
      total += audioBytes({ audio: trial.snapshot.audio.input }) + audioBytes({ audio: trial.snapshot.audio.output });
    }
  }
  return total;
}

function metadataBytes({ state }: { state: State }): number {
  return bytes({
    value: {
      plan: state.plan,
      sourceAudio: audioMetadata({ audio: state.sourceAudio }),
      load: state.load === undefined ? undefined : snapshotMetadata({ snapshot: state.load }),
      trials: state.trials.map(trial => {
        switch (trial.status) {
        case 'not_run': return trial;
        case 'in_progress': case 'completed': case 'partial': case 'cancelled': case 'failed': return { ...trial, snapshot: trial.snapshot === undefined ? undefined : snapshotMetadata({ snapshot: trial.snapshot }) };
        default: {
          const exhaustive: never = trial;
          throw new Error(String(exhaustive));
        }
        }
      }),
    },
  });
}

function stopState({ state, status, reason }: { state: State, status: 'partial' | 'cancelled' | 'failed', reason: string }): void {
  state.stopped = status;
  state.trials = state.trials.map(trial => {
    switch (trial.status) {
    case 'not_run': return { ...trial, reason };
    case 'in_progress': case 'completed': case 'partial': case 'cancelled': case 'failed': return trial;
    default: {
      const exhaustive: never = trial;
      throw new Error(String(exhaustive));
    }
    }
  });
}

function collectionStatus({ state }: { state: State }): SpeechInvestigationCollectionSnapshot['status'] {
  if (state.stopped !== undefined) {
    return state.stopped;
  }
  if (state.trials.length === 0) {
    return state.load?.status ?? 'in_progress';
  }
  let status: SpeechInvestigationCollectionSnapshot['status'] = 'completed';
  for (const trial of state.trials) {
    switch (trial.status) {
    case 'not_run': case 'in_progress': return 'in_progress';
    case 'completed': break;
    case 'partial': case 'cancelled': case 'failed': status = 'partial';
      break;
    default: {
      const exhaustive: never = trial;
      throw new Error(String(exhaustive));
    }
    }
  }
  return status;
}

/** Stores immutable observations only; it does not schedule inference or own URLs. */
export function createSpeechInvestigationCollection({ plan, sourceAudio }: { plan: SpeechInvestigationPlan, sourceAudio: SpeechInvestigationAudio }) {
  if (plan.trials.length > limits.trials || new Set(plan.trials.map(trial => trial.id)).size !== plan.trials.length || plan.trials.some(trial => !trial.id || trial.id.length > 128)) {
    throw new Error('Invalid speech investigation trial plan');
  }
  if (bytes({ value: plan }) > limits.planBytes) {
    throw new Error('Speech investigation plan exceeds its metadata limit');
  }
  const copied = structuredClone(plan);
  freeze({ value: copied });
  let current: State | undefined = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    plan: copied,
    sourceAudio: { ...sourceAudio },
    load: undefined,
    trials: plan.trials.map((trial, index) => ({ id: trial.id, index: index + 1, status: 'not_run', reason: 'Not started' })),
    active: undefined,
    stopped: undefined,
    limitReason: undefined,
  };
  if (audioBytes({ audio: sourceAudio }) > limits.audioBytes) {
    current.sourceAudio = { status: 'unavailable', reason: 'Common source exceeds the collection audio limit' };
    current.limitReason = 'Common source exceeds the collection audio limit';
    stopState({ state: current, status: 'partial', reason: current.limitReason });
  }

  function admit({ state, snapshot, index, id }: { state: State, snapshot: SpeechInvestigationSnapshot, index: number, id: string }): RecordedTrial {
    let remaining = limits.audioBytes - retainedBytes({ state });
    let reason: string | undefined;
    let shared = state.sourceAudio;
    if (shared.status !== 'retained' && snapshot.audio.source.status === 'retained') {
      if (snapshot.audio.source.blob.size <= remaining) {
        shared = snapshot.audio.source;
        remaining -= shared.blob.size;
        state.sourceAudio = shared;
      } else {
        reason = 'Common source exceeds the remaining collection audio budget';
      }
    } else if (shared.status === 'retained' && snapshot.audio.source.status === 'retained' && shared.blob !== snapshot.audio.source.blob) {
      reason = 'Trial source differs from the fixed common source File';
    }
    const sourceLink: SpeechInvestigationAudio = reason === undefined ? { status: 'not_applicable', reason: 'Common original audio is described by collection.sourceAudio' } : { status: 'unavailable', reason };
    const audio = { ...snapshot.audio, source: sourceLink };
    // Preserve generated audio first; both roles still count toward one budget.
    for (const role of ['output', 'input'] as const) {
      const value = audio[role];
      switch (value.status) {
      case 'retained':
        if (value.blob.size <= remaining) {
          remaining -= value.blob.size;
        } else {
          reason ??= 'Trial audio exceeds the remaining collection audio budget';
          audio[role] = { status: 'unavailable', reason };
        }
        break;
      case 'unavailable': case 'not_applicable': break;
      default: {
        const exhaustive: never = value;
        throw new Error(String(exhaustive));
      }
      }
    }
    let accepted: SpeechInvestigationSnapshot | undefined = { ...snapshot, audio, capture: { ...snapshot.capture, audioBytes: audioBytes({ audio: audio.input }) + audioBytes({ audio: audio.output }) } };
    const trial: RecordedTrial = { id, index, status: snapshot.status, snapshot: accepted, capture: { status: reason === undefined ? 'complete' : 'partial', reason } };
    const previous = state.trials;
    state.trials = state.trials.map(value => value.id === id ? trial : value);
    if (metadataBytes({ state }) > limits.metadataBytes - 16 * 1024) {
      reason = 'Trial metadata exceeds the collection metadata limit';
      accepted = undefined;
      trial.snapshot = undefined;
      trial.capture = { status: 'partial', reason };
    }
    state.trials = previous;
    freeze({ value: trial });
    return trial;
  }

  return {
    remainingAudioBytes(): number {
      return current === undefined ? 0 : Math.max(0, limits.audioBytes - retainedBytes({ state: current }));
    },
    startTrial({ trialId }: { trialId: string }): boolean {
      const state = current;
      if (state === undefined || state.stopped !== undefined || state.active !== undefined) {
        return false;
      }
      const next = state.trials.find(trial => trial.status === 'not_run');
      if (next?.id !== trialId) {
        return false;
      }
      if (retainedBytes({ state }) >= limits.audioBytes) {
        state.limitReason = 'Collection audio budget is exhausted';
        stopState({ state, status: 'partial', reason: state.limitReason });
        return false;
      }
      state.active = trialId;
      state.trials = state.trials.map(trial => trial.id === trialId ? { id: trial.id, index: trial.index, status: 'in_progress', snapshot: undefined, capture: { status: 'partial', reason: 'No trial checkpoint has been observed yet' } } : trial);
      return true;
    },
    completeTrial({ trialId, snapshot, retention }: { trialId: string, snapshot: SpeechInvestigationSnapshot, retention: 'available' | 'limit' }): { kind: 'accepted' | 'limit', trial: RecordedTrial } | undefined {
      const state = current;
      if (state === undefined || state.active !== trialId) {
        return undefined;
      }
      switch (snapshot.status) {
      case 'in_progress': throw new Error('A completed trial requires a terminal snapshot');
      case 'completed': case 'partial': case 'cancelled': case 'failed': break;
      default: {
        const exhaustive: never = snapshot.status;
        throw new Error(String(exhaustive));
      }
      }
      const previous = state.trials.find(trial => trial.id === trialId);
      if (previous === undefined) {
        return undefined;
      }
      let trial = admit({ state, snapshot, index: previous.index, id: trialId });
      switch (retention) {
      case 'available': break;
      case 'limit': trial = { ...trial, capture: { status: 'partial', reason: 'Active trial reached its retained-audio limit' } };
        freeze({ value: trial });
        break;
      default: {
        const exhaustive: never = retention;
        throw new Error(String(exhaustive));
      }
      }
      state.trials = state.trials.map(value => value.id === trialId ? trial : value);
      state.active = undefined;
      switch (trial.status) {
      case 'failed': if (state.stopped === undefined) {
        stopState({ state, status: 'failed', reason: 'Trial failed; remaining trials were not run' });
      } else {
        state.stopped = 'failed';
      }
        break;
      case 'cancelled': if (state.stopped === undefined) {
        stopState({ state, status: 'cancelled', reason: 'Trial was cancelled; remaining trials were not run' });
      }
        break;
      case 'completed': case 'partial': case 'in_progress': break;
      default: {
        const exhaustive: never = trial.status;
        throw new Error(String(exhaustive));
      }
      }
      switch (trial.capture.status) {
      case 'partial':
        state.limitReason = trial.capture.reason;
        stopState({ state, status: state.stopped ?? 'partial', reason: trial.capture.reason ?? 'Incomplete collection capture' });
        return { kind: 'limit', trial };
      case 'complete': return { kind: 'accepted', trial };
      default: {
        const exhaustive: never = trial.capture.status;
        throw new Error(String(exhaustive));
      }
      }
    },
    setLoad({ snapshot }: { snapshot: SpeechInvestigationSnapshot }): boolean {
      const state = current;
      if (state === undefined || state.active !== undefined) {
        return false;
      }
      switch (snapshot.operation.source.kind) {
      case 'unset': break;
      case 'file': case 'recording': throw new Error('The model-load slot cannot contain a processing trial');
      default: {
        const exhaustive: never = snapshot.operation.source;
        throw new Error(String(exhaustive));
      }
      }
      const previous = state.load;
      state.load = { ...snapshot, audio: { source: { status: 'not_applicable', reason: 'Model load has no source audio' }, input: { status: 'not_applicable', reason: 'Model load has no input PCM' }, output: { status: 'not_applicable', reason: 'Model load produces no audio' } }, capture: { ...snapshot.capture, audioBytes: 0 } };
      if (metadataBytes({ state }) > limits.metadataBytes - 16 * 1024) {
        state.load = previous;
        state.limitReason = 'Model-load metadata exceeds the collection metadata limit';
        stopState({ state, status: 'partial', reason: state.limitReason });
        return false;
      }
      freeze({ value: state.load });
      return true;
    },
    stop({ status, reason }: { status: 'partial' | 'cancelled' | 'failed', reason: string }): void {
      if (current !== undefined) {
        stopState({ state: current, status, reason });
      }
    },
    snapshot({ active }: { active: { trialId: string, snapshot: SpeechInvestigationSnapshot } | undefined }): SpeechInvestigationCollectionSnapshot | undefined {
      const state = current;
      if (state === undefined) {
        return undefined;
      }
      const copy: State = { ...state, trials: [...state.trials] };
      if (active !== undefined && state.active === active.trialId) {
        const trial = state.trials.find(value => value.id === active.trialId);
        if (trial !== undefined) {
          const admitted = admit({ state: copy, snapshot: active.snapshot, index: trial.index, id: trial.id });
          copy.trials = copy.trials.map(value => value.id === trial.id ? admitted : value);
          switch (admitted.capture.status) {
          case 'partial': copy.limitReason = admitted.capture.reason;
            break;
          case 'complete': break;
          default: {
            const exhaustive: never = admitted.capture.status;
            throw new Error(String(exhaustive));
          }
          }
        }
      }
      const snapshot: SpeechInvestigationCollectionSnapshot = { id: state.id, createdAt: state.createdAt, capturedAt: new Date().toISOString(), status: collectionStatus({ state: copy }), plan: state.plan, load: copy.load, sourceAudio: copy.sourceAudio, trials: copy.trials, capture: { audioBytes: retainedBytes({ state: copy }), metadataBytes: metadataBytes({ state: copy }), limitReason: copy.limitReason } };
      freeze({ value: snapshot });
      return snapshot;
    },
    clear(): void {
      current = undefined;
    },
  };
}

export const TEST_ONLY = {
};
