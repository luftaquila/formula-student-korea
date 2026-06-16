<script setup>
// 무선 모드 가속 = 유선 AccelView를 그대로 재사용(스타일·로직 동일), 데이터만 무선 store.
import AccelView from "./AccelView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("accel");
</script>

<template>
  <AccelView :source="source" :wireless="true" />
</template>
