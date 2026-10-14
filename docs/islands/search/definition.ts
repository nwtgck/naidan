import { defineDocsIsland } from '../core';
import SearchIsland from './SearchIsland.vue';
import { searchSpec } from './contracts';
import { prepareSearchMessages } from './messages';

export const searchIsland = defineDocsIsland({
  spec: searchSpec,
  component: SearchIsland,
  prepare: async ({ payload }) => {
    await prepareSearchMessages({ locale: payload.locale });
  },
});
