import type { SpeechFileRunState } from './speech-file-run';
import type { LiveAudioClip } from './audio-retention';
import type { SpeechInvestigationAudio, SpeechInvestigationSnapshot } from '@/features/speech-cpp-browser/investigation/types';

export type SpeechResponseResultView = { trialId: string, run: SpeechFileRunState, modelLoadMilliseconds: number | undefined };

/** Presentation URLs belong to this comparison, independently of the runtime's
 * next run. Only audio already accepted by the collection budget may enter. */
export function createSpeechResponseResultViews() {
  const urls = new Set<string>();
  function clip({ value, audio, created }: { value: LiveAudioClip | undefined, audio: SpeechInvestigationAudio, created: string[] }): LiveAudioClip | undefined {
    if (value === undefined) {
      return undefined;
    }
    switch (audio.status) {
    case 'retained': {
      const { url: _runtimeUrl, sampleRate, seconds, status, ...unhandled } = value;
      unhandled satisfies Record<PropertyKey, never>;
      const url = URL.createObjectURL(audio.blob);
      created.push(url);
      return { url, sampleRate, seconds, status };
    }
    case 'unavailable': case 'not_applicable': return undefined;
    default: {
      const exhaustive: never = audio;
      throw new Error(String(exhaustive));
    }
    }
  }
  return {
    retain({ trialId, run, audio, modelLoadMilliseconds }: { trialId: string, run: SpeechFileRunState, audio: SpeechInvestigationSnapshot['audio'], modelLoadMilliseconds: number | undefined }): SpeechResponseResultView {
      const created: string[] = [];
      try {
        const input = clip({ value: run.input, audio: audio.input, created });
        const output = clip({ value: run.output, audio: audio.output, created });
        for (const url of created) {
          urls.add(url);
        }
        return { trialId, run: { ...run, input, output }, modelLoadMilliseconds };
      } catch (error) {
        for (const url of created) {
          URL.revokeObjectURL(url);
        }
        throw error;
      }
    },
    clear(): void {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    },
  };
}

export const TEST_ONLY = {
};
