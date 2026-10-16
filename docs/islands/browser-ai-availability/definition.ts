import { defineDocsIsland } from '../core';
import BrowserAiAvailability from './BrowserAiAvailability.vue';
import { browserAiAvailabilitySpec } from './contracts';
import { prepareBrowserAiMessages } from './messages';

export const browserAiAvailabilityIsland = defineDocsIsland({
  spec: browserAiAvailabilitySpec,
  component: BrowserAiAvailability,
  prepare: async ({ payload }) => {
    await prepareBrowserAiMessages({ locale: payload.locale });
  },
});
