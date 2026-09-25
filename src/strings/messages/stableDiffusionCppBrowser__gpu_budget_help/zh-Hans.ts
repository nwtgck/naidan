export const stableDiffusionCppBrowser__gpu_budget_help = (): string => "留空时不设置管理预算，而是使用设备的分配限制。可选预算涵盖常驻权重和工作缓冲区，并非模型文件大小限制。预算过小可能导致生成失败或增加传输；数值更大也不代表有足够的可用内存。为 Wasm32 显式设置的预算必须小于 4096 MiB。";
