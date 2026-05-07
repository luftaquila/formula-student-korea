<script setup>
defineProps({
  lineX: { type: Number, required: true },
  active: { type: Boolean, default: false },
});

const emit = defineEmits(["pointerdown"]);

function onPointerDown(event) {
  emit("pointerdown", event);
}
</script>

<template>
  <div
    class="sticky-freeze-line"
    :class="{ 'is-active': active }"
    :style="{ left: lineX + 'px' }"
    @pointerdown="onPointerDown"
  >
    <div class="sticky-freeze-line__bar"></div>
  </div>
</template>

<style scoped>
.sticky-freeze-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 13px;
  margin-left: -6px;
  z-index: 10;
  cursor: col-resize;
  touch-action: none;
}

.sticky-freeze-line__bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 3px;
  background: var(--accent-primary);
  opacity: 0.45;
  transition: opacity 0.15s ease, width 0.15s ease, left 0.15s ease;
  pointer-events: none;
}

.sticky-freeze-line:hover .sticky-freeze-line__bar,
.sticky-freeze-line.is-active .sticky-freeze-line__bar {
  opacity: 1;
  width: 4px;
  left: 4.5px;
}
</style>
