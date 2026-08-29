<script setup lang="ts">
import type * as Comlink from "comlink";

declare function wrapWorkerRemote<Api>(endpoint: Comlink.Endpoint): Comlink.Remote<Api>;
declare const endpoint: Comlink.Endpoint;

interface UnsafeVueApi {
  run(request: { callback: () => void }): Promise<void>;
}
wrapWorkerRemote<UnsafeVueApi>(endpoint);
</script>

<template><div /></template>
