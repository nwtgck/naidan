export const useSettings__storage_type_is_already_set_and_requested_type_was_ignored = ({ savedStorageType, requestedStorageType }: { savedStorageType: string; requestedStorageType: string }): string => (
  `ストレージ種別はすでに「${savedStorageType}」に設定されています。クエリパラメーターで要求された「${requestedStorageType}」は無視されました。`
);
