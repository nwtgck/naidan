export const stableDiffusionCppBrowser__bf16_weight_storage_help = (): string => "F32 保留 BF16 数值，但权重内存用量会加倍。F16 可减少内存用量，但可能损失精度和数值范围。BF16 保留受支持的矩阵和嵌入权重；归一化权重和偏置仍可能使用 F32。现有量化保持不变。";
