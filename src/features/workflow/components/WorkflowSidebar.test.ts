import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toWorkflowId } from '@/01-models/ids';
import type { WorkflowDefinition } from '@/01-models/workflow';
import type { WorkflowDocumentListing } from '@/00-storage/service/workflow-document';
import type { WorkflowWorkspace } from '@/features/workflow/composables/use-workflow-workspace';
import WorkflowSidebar from './WorkflowSidebar.vue';
import WorkflowSidebarActions from './WorkflowSidebarActions.vue';

const expanded = ref(true);
const busy = ref(false);
const navigationLocked = ref(false);
const workspace = {
  busy: computed(() => busy.value),
  navigationLocked: computed(() => navigationLocked.value),
  definition: shallowRef<WorkflowDefinition>({ name: 'Original', steps: [] }),
  library: shallowRef<WorkflowDocumentListing>({ items: [], unreadable: [] }),
  activeRunId: shallowRef<WorkflowWorkspace['activeRunId']['value']>(),
  pending: shallowRef<WorkflowWorkspace['pending']['value']>(),
  runState: ref<WorkflowWorkspace['runState']['value']>('idle'),
  create: vi.fn<WorkflowWorkspace['create']>(),
  sample: vi.fn<WorkflowWorkspace['sample']>(),
  insertPart: vi.fn<WorkflowWorkspace['insertPart']>(),
  refresh: vi.fn<WorkflowWorkspace['refresh']>(),
} satisfies Pick<WorkflowWorkspace, 'busy' | 'navigationLocked' | 'definition' | 'library' | 'activeRunId' | 'pending' | 'runState' | 'create' | 'sample' | 'insertPart' | 'refresh'>;
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: expanded }) }));
vi.mock('@/features/workflow/composables/use-workflow-workspace', () => ({ useWorkflowWorkspace: () => workspace }));

beforeEach(async () => {
  expanded.value = true;
  busy.value = false;
  navigationLocked.value = false;
  workspace.definition.value = { name: 'Original', steps: [] };
  workspace.library.value = { items: [], unreadable: [] };
  workspace.activeRunId.value = undefined;
  workspace.pending.value = undefined;
  workspace.runState.value = 'idle';
  workspace.create.mockReset();
  workspace.sample.mockReset();
  workspace.insertPart.mockReset();
  workspace.refresh.mockReset();
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/workflows/runs?settings=appearance');
  const wrapper = mount(defineComponent({
    setup() {
      return () => h('div', [h(WorkflowSidebarActions, { expanded: expanded.value }), h(WorkflowSidebar)]);
    },
  }), { global: { plugins: [router] } });
  return {
    wrapper,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Workflow sidebar content and actions', () => {
  it('uses the same workspace busy state while creating and preserves route query on acceptance', async () => {
    const gate = Promise.withResolvers<void>();
    workspace.create.mockImplementation(async () => {
      busy.value = true;
      await gate.promise;
      workspace.definition.value = { name: 'New', steps: [] };
      busy.value = false;
    });
    using f = await fixture();
    try {
      await f.wrapper.get('[data-testid="workflow-sidebar-new"]').trigger('click');
      expect(workspace.create).toHaveBeenCalledWith({ documentKind: 'workflow' });
      expect(f.wrapper.get('[data-testid="workflow-sidebar-new"]').attributes('disabled')).toBeDefined();
      expect(f.wrapper.get('[data-testid="workflow-sidebar-sample"]').attributes('disabled')).toBeDefined();
      expect(f.wrapper.get('[data-testid="workflow-sidebar-refresh"]').attributes('disabled')).toBeDefined();
    } finally {
      gate.resolve();
      await flushPromises();
    }
    expect(f.router.currentRoute.value.path).toBe('/workflows');
    expect(f.router.currentRoute.value.query).toEqual({ settings: 'appearance' });
  });

  it('keeps the current route when creation is cancelled and delegates the sample from the body', async () => {
    using f = await fixture();
    await f.wrapper.get('[data-testid="workflow-sidebar-new"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/workflows/runs');
    workspace.sample.mockImplementation(async () => {
      workspace.definition.value = { name: 'Sample', steps: [] };
    });
    await f.wrapper.get('[data-testid="workflow-sidebar-sample"]').trigger('click');
    await flushPromises();
    expect(workspace.sample).toHaveBeenCalledOnce();
    expect(f.router.currentRoute.value.path).toBe('/workflows');
  });

  it('preserves part insertion locking and document navigation', async () => {
    const id = toWorkflowId({ raw: 'part' });
    workspace.library.value = { items: [{ id, kind: 'part', name: 'Reusable part', createdAt: 1, updatedAt: 1 }], unreadable: [] };
    using f = await fixture();
    const insert = f.wrapper.get('[data-testid="workflow-sidebar-insert-part"]');
    navigationLocked.value = true;
    await flushPromises();
    expect(insert.attributes('disabled')).toBeDefined();
    navigationLocked.value = false;
    await flushPromises();
    await insert.trigger('click');
    expect(workspace.insertPart).toHaveBeenCalledWith({ id, target: { parentId: undefined, branch: 'root', index: 0 } });
    await f.wrapper.get('[data-testid="workflow-sidebar-document"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/workflows/part');
    expect(f.router.currentRoute.value.query).toEqual({ settings: 'appearance' });
  });

  it('keeps creation, history and refresh reachable when collapsed', async () => {
    expanded.value = false;
    using f = await fixture();
    expect(f.wrapper.get('[data-testid="workflow-sidebar-new"]').attributes('aria-label')).toBeTruthy();
    expect(f.wrapper.find('[data-testid="workflow-sidebar-sample"]').exists()).toBe(false);
    const history = f.wrapper.get('a[href="/workflows/runs"]');
    expect(history.attributes('aria-label')).toBeTruthy();
    await history.trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/workflows/runs');
    await f.wrapper.get('[data-testid="workflow-sidebar-refresh"]').trigger('click');
    expect(workspace.refresh).toHaveBeenCalledOnce();
  });
});
