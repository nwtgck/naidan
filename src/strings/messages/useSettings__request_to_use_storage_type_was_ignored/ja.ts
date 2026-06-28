export const useSettings__request_to_use_storage_type_was_ignored = ({ savedStorageType, requestedStorageType }: { savedStorageType: string; requestedStorageType: string }): string => (
  `ストレージ種別はすでに「${savedStorageType}」に設定されています。クエリパラメーターによる「${requestedStorageType}」の使用要求は無視されました。`
);
