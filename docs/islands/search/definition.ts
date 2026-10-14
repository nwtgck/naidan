import { defineDocsIsland } from '../core';
import SearchIsland from './SearchIsland.vue';
import { searchSpec } from './contracts';

export const searchIsland = defineDocsIsland({ spec: searchSpec, component: SearchIsland });
