<template>
  <a
    :href="path"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
    class="service-card"
  >
    <div v-if="svgIcon" class="icon icon-svg" v-html="svgIcon"></div>
    <div v-else class="icon">{{ icon }}</div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <svg v-if="external" class="external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  </a>
</template>

<script setup>
defineProps({
  title: String,
  description: String,
  path: String,
  icon: String,
  svgIcon: String,
  external: {
    type: Boolean,
    default: false,
  },
});
</script>

<style scoped>
.service-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1.25rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  text-decoration: none;
  color: var(--text-primary);
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
  cursor: pointer;
  box-shadow: var(--shadow-card);
}

.service-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-hover);
  border-color: var(--accent-primary);
}

.icon {
  font-size: 3rem;
  margin-bottom: 1.25rem;
  line-height: 1;
  height: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-svg :deep(svg) {
  width: 3rem;
  height: 3rem;
}

h3 {
  font-size: 1.2rem;
  font-weight: 600;
  margin-bottom: 0.375rem;
  color: var(--text-primary);
  text-align: center;
  word-break: keep-all;
}

p {
  font-size: 0.9rem;
  color: var(--text-secondary);
  text-align: center;
}

.external-icon {
  position: absolute;
  top: 1rem;
  right: 1rem;
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  opacity: 0.6;
}

@media (max-width: 768px) {
  .service-card {
    padding: 2.5rem 1.5rem 2rem;
  }

  h3 {
    font-size: 1.125rem;
  }

  p {
    font-size: 0.85rem;
  }
}

@media (max-width: 480px) {
  .service-card {
    padding: 2rem 1rem 1.5rem;
  }

  .icon {
    font-size: 2.5rem;
    height: 2.5rem;
    margin-bottom: 1rem;
  }

  .icon-svg :deep(svg) {
    width: 2.5rem;
    height: 2.5rem;
  }

  h3 {
    font-size: 1rem;
  }

  p {
    font-size: 0.8rem;
  }
}
</style>
