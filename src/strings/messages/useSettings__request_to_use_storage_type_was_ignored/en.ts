export const useSettings__request_to_use_storage_type_was_ignored = ({ savedStorageType, requestedStorageType }: { savedStorageType: string; requestedStorageType: string }): string => (
  `Storage type is already set to "${savedStorageType}". The request to use "${requestedStorageType}" via query parameter was ignored.`
);
