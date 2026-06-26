export const useSettings__storage_type_is_already_set_and_requested_type_was_ignored = ({ savedStorageType, requestedStorageType }: { savedStorageType: string; requestedStorageType: string }): string => (
  `Storage type is already set to "${savedStorageType}". The requested type "${requestedStorageType}" via query parameter was ignored.`
);
