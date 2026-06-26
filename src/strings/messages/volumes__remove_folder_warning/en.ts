export const volumes__remove_folder_warning = ({ name }: { name: string }): string => (
  `Are you sure you want to remove "${name}"? This will stop using it. Your original files will not be affected.`
);
