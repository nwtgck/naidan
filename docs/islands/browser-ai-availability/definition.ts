import { defineDocsIsland } from '../core';
import BrowserAiAvailability from './BrowserAiAvailability.vue';
import { browserAiAvailabilitySpec } from './contracts';

export const browserAiAvailabilityIsland = defineDocsIsland({ spec: browserAiAvailabilitySpec, component: BrowserAiAvailability });
