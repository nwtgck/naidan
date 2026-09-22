import context from './provider-resource-context.evidence.json';
import provenance from './provider-source-provenance.evidence.json';
import sequence from './provider-sequence-full.evidence.json';
import request1 from './provider-first-turn.evidence.json';
import request2 from './provider-continuity.evidence.json';
import request3 from './provider-independent-next-input.evidence.json';
import request4 from './provider-system-user.evidence.json';
import request5 from './provider-supplied-history.evidence.json';
import request6 from './provider-reasoning-none.evidence.json';
import request7 from './provider-reasoning-low.evidence.json';
import request8 from './provider-reasoning-medium.evidence.json';
import request9 from './provider-reasoning-high.evidence.json';
import request10 from './provider-natural-tool-minimal.evidence.json';
import request11 from './provider-natural-tool-representative.evidence.json';
import request12 from './provider-structured-tool-history.evidence.json';
import request13 from './provider-image.evidence.json';
import type { ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';

// Explicit case references: adding evidence never registers a test implicitly.
export const providerReplayCatalog = {
  context, provenance, sequence,
  cases: {
    'first-turn': request1,
    'continuity': request2,
    'independent-next-input': request3,
    'system-user': request4,
    'supplied-history': request5,
    'reasoning-none': request6,
    'reasoning-low': request7,
    'reasoning-medium': request8,
    'reasoning-high': request9,
    'natural-tool-minimal': request10,
    'natural-tool-representative': request11,
    'structured-tool-history': request12,
    'image': request13,
  },
} satisfies ProviderReplayCatalog;

export const TEST_ONLY = {
};
