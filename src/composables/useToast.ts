import { ref } from 'vue';

export interface Toast {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  duration?: number;
}

const toasts = ref<Toast[]>([]);

const addToast = (toast: Omit<Toast, 'id'>) => {
  const id = Math.random().toString(36).substring(2, 9);
  const newToast = { ...toast, id };
  
  toasts.value.push(newToast);

  if (toast.duration !== 0) {
    setTimeout(() => {
      removeToast(id);
    }, toast.duration || 20000);
  }
  
  return id;
};

const removeToast = (id: string) => {
  toasts.value = toasts.value.filter(t => t.id !== id);
};

export const toastStore = {
  toasts,
  addToast,
  removeToast,
};

export function useToast() {
  return toastStore;
}
