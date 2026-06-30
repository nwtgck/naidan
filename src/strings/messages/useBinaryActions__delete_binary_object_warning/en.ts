export const useBinaryActions__delete_binary_object_warning = ({ name }: { name: string }): string => (
  `Are you sure you want to delete "${name}"? This action cannot be undone. Any chat messages referencing this file will show it as missing.`
);
