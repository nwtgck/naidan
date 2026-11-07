import { createWebHashHistory, type RouterHistory } from 'vue-router';
import { createModelPageHistory } from '@/features/llama-cpp-browser/model-launch/page-history';
import { isModelPagePath } from '@/features/llama-cpp-browser/model-launch/page-url';

export function createAppHistory(): RouterHistory {
  const modelPage = window.location.protocol !== 'file:' && isModelPagePath({ pathname: window.location.pathname });
  return modelPage ? createModelPageHistory() : createWebHashHistory();
}

export const TEST_ONLY = {
};
