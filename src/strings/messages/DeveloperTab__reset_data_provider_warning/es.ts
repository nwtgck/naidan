export const DeveloperTab__reset_data_provider_warning = ({ storageType }: { storageType: string }): string => (
  `Esta acción no se puede deshacer. Eliminará permanentemente todo el historial de chats, los grupos de chats y la configuración almacenados en el proveedor ${storageType}.`
);
