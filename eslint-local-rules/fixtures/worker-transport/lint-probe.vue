<script setup lang="ts">
import * as Comlink from "comlink";

declare const worker: Worker;
worker.postMessage({ type: "vue" });
void Comlink;
</script>

<template><div /></template>
