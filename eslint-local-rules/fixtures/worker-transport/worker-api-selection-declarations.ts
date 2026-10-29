// Semantic call-selection fixtures; never execute these declarations.
export interface UnsafeApi { send(value: { callback: () => void }): void }
export declare function wrapWorkerRemote<T>(worker?: Worker): T;
export declare function exposeWorkerRemote<T>(api: T): void;
export declare function ordinary<T>(value: unknown): T;
export declare function overloaded<T>(value: string): T;
export declare function overloaded<T>(value: number): T;
export declare function overloaded<T>(value: Worker): T;
