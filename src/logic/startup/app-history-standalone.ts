import { createWebHashHistory, type RouterHistory } from 'vue-router';

// Build-time facade: file:// never imports the hosted path-history adapter.
export function createAppHistory(): RouterHistory {
  return createWebHashHistory();
}

export const TEST_ONLY = {
};
