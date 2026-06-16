<script setup>
import GymkhanaView from "./GymkhanaView.vue";
import { useWirelessStore } from "../stores/wireless";

const source = useWirelessStore().sourceFor("gymkhana");
</script>

<template>
  <GymkhanaView :source="source" :wireless="true" />
</template>
