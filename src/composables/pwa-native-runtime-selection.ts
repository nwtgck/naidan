import imageConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import speechConfiguration from 'virtual:speech-cpp-browser/config';
import { initialProfile } from '@/features/stable-diffusion-cpp-browser/capabilities';
import { configurationSchema } from '@/features/stable-diffusion-cpp-browser/types';
import { speechHostedUnavailableReason } from '@/features/speech-cpp-browser/runtime/hosted-capability';
import type { RuntimeSelection } from '@/logic/pwa/asset-cache-protocol';

export function selectNativePWAProfiles(): Record<'stable-diffusion-cpp-browser' | 'speech-cpp-browser', RuntimeSelection> {
  const image = configurationSchema.safeParse(imageConfiguration);
  const imageRuntime = ((): RuntimeSelection => {
    if (!image.success) {
      return { status: 'unknown' };
    }
    const configuration = image.data;
    switch (configuration.kind) {
    case 'unavailable': return { status: 'known', profiles: [] };
    case 'available': {
      const imageProfile = initialProfile();
      return configuration.artifacts.some(artifact => artifact.profile === imageProfile)
        ? { status: 'known', profiles: [imageProfile] } : { status: 'unknown' };
    }
    default: {
      const exhaustive: never = configuration;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const speechRuntime: RuntimeSelection =
    speechConfiguration.kind === 'available' && speechHostedUnavailableReason({ configuration: speechConfiguration }) === undefined
      ? { status: 'known', profiles: [speechConfiguration.artifact.profile] }
      : { status: 'known', profiles: [] };
  return { 'stable-diffusion-cpp-browser': imageRuntime, 'speech-cpp-browser': speechRuntime };
}

export const TEST_ONLY = {
};
