export const DeveloperTab__reset_data_provider_warning = ({ storageType }: { storageType: string }): string => (
  `Esta ação não pode ser desfeita. Ela excluirá permanentemente todo o histórico de conversas, grupos de conversas e configurações armazenados no provedor ${storageType}.`
);
