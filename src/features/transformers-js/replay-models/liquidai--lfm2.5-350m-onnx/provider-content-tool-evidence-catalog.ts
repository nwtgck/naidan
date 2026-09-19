import type { ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import context from './provider-content-tool-resource-context.evidence.json';
import provenance from './provider-content-tool-source-provenance.evidence.json';
import sequence from './provider-content-tool-sequence-full.evidence.json';
import request1 from './provider-content-tool-first-turn.evidence.json';
import request2 from './provider-content-tool-continuity.evidence.json';
import request3 from './provider-content-tool-independent-next-input.evidence.json';
import request4 from './provider-content-tool-system-user.evidence.json';
import request5 from './provider-content-tool-supplied-history.evidence.json';
import request6 from './provider-content-tool-reasoning-none.evidence.json';
import request7 from './provider-content-tool-reasoning-low.evidence.json';
import request8 from './provider-content-tool-reasoning-medium.evidence.json';
import request9 from './provider-content-tool-reasoning-high.evidence.json';
import request10 from './provider-content-tool-natural-tool-minimal.evidence.json';
import request11 from './provider-content-tool-natural-tool-representative.evidence.json';
import request12 from './provider-content-tool-structured-tool-history.evidence.json';
import request13 from './provider-content-tool-image.evidence.json';

// One post-repair capture. Historical source/cases remain independently pinned.
export const contentToolProviderReplayCatalog = {
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
