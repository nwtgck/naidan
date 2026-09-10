import { z } from 'zod';

// This internal RPC value owns one Provider.chat tool loop. Undefined keeps
// older/direct callers on fresh input. It is neither a saved chat ID nor Evidence.
export const generationContinuationOwnerSchema = z.uuid().optional();

export const TEST_ONLY = {
};
