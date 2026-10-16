import { defineDocsIsland } from '../core';
import BranchingDemo from './BranchingDemo.vue';
import { branchingSpec } from './contracts';
import { prepareBranchingMessages } from './messages';

export const branchingIsland = defineDocsIsland({
  spec: branchingSpec,
  component: BranchingDemo,
  prepare: async ({ payload }) => {
    await prepareBranchingMessages({ locale: payload.locale });
  },
});
