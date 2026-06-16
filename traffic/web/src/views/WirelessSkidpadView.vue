<script setup>
import SkidpadView from "./SkidpadView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("skidpad");
</script>

<template>
  <SkidpadView :source="source" :wireless="true" />
</template>
