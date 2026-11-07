import { createWebHashHistory, type RouterHistory } from 'vue-router';
import { createModelSeoHistory } from '@/features/llama-cpp-browser/model-launch/seo-history';
import { findModelSeoEntry } from '@/features/llama-cpp-browser/model-launch/seo-entries';

export function createAppHistory(): RouterHistory {
  const entry = window.location.protocol === 'file:' ? undefined : findModelSeoEntry({ pathname: window.location.pathname });
  return entry === undefined ? createWebHashHistory() : createModelSeoHistory({ entry });
}

export const TEST_ONLY = {
};
