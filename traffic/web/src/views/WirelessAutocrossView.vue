<script setup>
import AutocrossView from "./AutocrossView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("autocross");
</script>

<template>
  <AutocrossView :source="source" :wireless="true" />
</template>
