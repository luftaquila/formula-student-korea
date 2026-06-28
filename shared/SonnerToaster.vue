<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { Toaster } from "vue-sonner";

// sonner Toaster 의 theme prop 을 사이트 테마(documentElement[data-theme])에 묶는다.
// 토글/다른 탭/초기화 등 모든 경로의 변경을 MutationObserver 로 감지해 light/dark 동기화.
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

const theme = ref(currentTheme());
let observer;

onMounted(() => {
  theme.value = currentTheme();
  observer = new MutationObserver(() => {
    theme.value = currentTheme();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
});

onUnmounted(() => {
  observer?.disconnect();
});
</script>

<template>
  <Toaster rich-colors :theme="theme" position="bottom-right" :duration="3500" />
</template>
