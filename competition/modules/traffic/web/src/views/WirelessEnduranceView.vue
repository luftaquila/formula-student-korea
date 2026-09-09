<script setup>
import EnduranceView from "./EnduranceView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("endurance");
</script>

<template>
  <EnduranceView :source="source" :wireless="true" />
</template>
