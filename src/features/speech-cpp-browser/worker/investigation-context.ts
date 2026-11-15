import { z } from 'zod';
import type { SpeechInvestigationObserver } from '@/features/speech-cpp-browser/investigation/types';

export const speechInvestigationContextSchema = z.object({ operationId: z.string().min(1).max(128), source: z.literal('investigation') });
export type SpeechInvestigationContext = z.infer<typeof speechInvestigationContextSchema>;
export type SpeechInvestigationBinding = { context: SpeechInvestigationContext, observer: SpeechInvestigationObserver };

export const TEST_ONLY = {
};
