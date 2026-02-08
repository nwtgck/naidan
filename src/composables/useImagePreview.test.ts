import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { useImagePreview } from './useImagePreview';

describe('useImagePreview', () => {
  it('manages preview state locally when not provided', () => {
    const { state, openPreview, closePreview } = useImagePreview();
    
    expect(state.value).toBeNull();

    const mockObjects = [{ id: '1', mimeType: 'image/png', size: 100, createdAt: 1000 }];
    openPreview({ objects: mockObjects, initialId: '1' });

    expect(state.value).toEqual({
      objects: mockObjects,
      initialId: '1'
    });

    closePreview();
    expect(state.value).toBeNull();
  });

  it('shares state across calls via provide/inject', async () => {
    let instance1: any;
    let instance2: any;

    const TestComponent = defineComponent({
      setup(_, { slots }) {
        instance1 = useImagePreview(true); // Provide
        return () => slots.default?.();
      }
    });

    const ChildComponent = defineComponent({
      setup() {
        instance2 = useImagePreview(); // Inject
        return () => null;
      }
    });

    const wrapper = mount(defineComponent({
      components: { TestComponent, ChildComponent },
      template: '<TestComponent><ChildComponent /></TestComponent>'
    }));

    instance1.openPreview({ objects: [], initialId: 'test' });
    expect(instance2.state.value?.initialId).toBe('test');
    
    wrapper.unmount();
  });

  it('maintains independent states for different scoped providers', () => {
    let scope1: any;
    let scope2: any;

    const Comp1 = defineComponent({
      setup() {
        scope1 = useImagePreview(true);
        return () => null;
      }
    });

    const Comp2 = defineComponent({
      setup() {
        scope2 = useImagePreview(true);
        return () => null;
      }
    });

    mount(Comp1);
    mount(Comp2);

    scope1.openPreview({ objects: [], initialId: 'id1' });
    scope2.openPreview({ objects: [], initialId: 'id2' });

    expect(scope1.state.value.initialId).toBe('id1');
    expect(scope2.state.value.initialId).toBe('id2');
  });
});
