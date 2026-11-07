import type { InjectionKey, Ref } from 'vue';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';

export const workflowValueScopeKey: InjectionKey<Readonly<Ref<WorkflowTypeScope>>> = Symbol('workflow-value-scope');
export const TEST_ONLY = {
};
