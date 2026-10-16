import { branchingSpec } from './branching/contracts';
import { searchSpec } from './search/contracts';
import { browserAiAvailabilitySpec } from './browser-ai-availability/contracts';

// The renderer imports only serialization contracts. Client entries import
// their own definitions, so a page never pulls unrelated components into SSR.
export const islandSpecs = {
  branching: branchingSpec,
  search: searchSpec,
  'browser-ai-availability': browserAiAvailabilitySpec,
} as const;

export type DocsIslandId = keyof typeof islandSpecs;
