import { defineDocsIsland } from '../core';
import BranchingDemo from './BranchingDemo.vue';
import { branchingSpec } from './contracts';

export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo });
