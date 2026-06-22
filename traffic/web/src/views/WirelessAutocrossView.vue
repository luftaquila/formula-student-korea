<script setup>
// 무선 모드 오토크로스 = StartFinishView를 무선 store facade로 렌더(가속과 동형).
import StartFinishView from "./StartFinishView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("autocross");
const config = { mode: "autocross", type: "오토크로스", defaultTitle: "Autocross" };
</script>

<template>
  <StartFinishView :source="source" :wireless="true" :config="config" />
</template>
