<script setup>
import { computed, ref, useId } from "vue";
import { inspectorDisplay } from "../utils/inspector-display.js";

const props = defineProps({
  names: { type: Array, required: true },
  category: { type: String, required: true },
});
const display = computed(() => inspectorDisplay(props.names));
const popover = ref(null);
const popoverId = useId();

function togglePopover(event) {
  const panel = popover.value;
  if (panel.matches(":popover-open")) {
    panel.hidePopover();
    return;
  }
  // Measure in the top layer so the table's scroll container cannot clip the list.
  panel.showPopover({ source: event.currentTarget });
  const trigger = event.currentTarget.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const edge = 8;
  panel.style.left = `${Math.max(edge, Math.min(trigger.left, window.innerWidth - bounds.width - edge))}px`;
  panel.style.top = `${Math.max(edge, Math.min(trigger.bottom + 4, window.innerHeight - bounds.height - edge))}px`;
}
</script>

<template>
  <span v-if="names.length" class="inspector-name">
    <span>{{ display.preview }}</span>
    <template v-if="display.expandable">
      {{ ' ' }}<button
        type="button"
        class="inspector-more"
        :popovertarget="popoverId"
        :aria-label="`${category} 검차관 ${names.length}명 전체 목록`"
        @click.stop.prevent="togglePopover"
        @keydown.stop
      >외 {{ display.remaining }}명</button>
      <span
        :id="popoverId"
        ref="popover"
        popover="auto"
        role="dialog"
        :aria-label="`${category} 전체 검차관`"
        class="inspector-popover"
        @click.stop
        @keydown.stop
      >
        <span v-for="(name, index) in names" :key="index" class="inspector-person">{{ name }}</span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.inspector-name {
  display: block;
  max-width: 10rem;
  margin-top: 0.125rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
  white-space: normal;
  overflow-wrap: anywhere;
}

.inspector-more {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent-primary);
  font: inherit;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.inspector-popover {
  position: fixed;
  inset: auto;
  margin: 0;
  width: max-content;
  max-width: calc(100vw - 2rem);
  max-height: min(20rem, calc(100dvh - 2rem));
  overflow: auto;
  padding: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  background: var(--bg-card);
  color: var(--text-secondary);
  box-shadow: 0 4px 16px rgb(0 0 0 / 15%);
  font-size: 0.75rem;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}

.inspector-person {
  display: block;
}

@media (max-width: 768px) {
  .inspector-name {
    max-width: 100%;
  }
}
</style>
