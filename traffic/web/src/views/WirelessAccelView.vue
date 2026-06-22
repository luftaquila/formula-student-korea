<script setup>
// 무선 모드 가속 = StartFinishView를 무선 store facade로 렌더(로직·템플릿 동일).
import StartFinishView from "./StartFinishView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("accel");
const config = { mode: "accel", type: "가속", defaultTitle: "Acceleration" };
</script>

<template>
  <StartFinishView :source="source" :wireless="true" :config="config" />
</template>
