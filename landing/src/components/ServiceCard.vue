<template>
  <a :href="path" class="service-card">
    <div class="icon">{{ icon }}</div>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
  </a>
</template>

<script setup>
defineProps({
  title: String,
  description: String,
  path: String,
  icon: String
})
</script>

<style scoped>
.service-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem 2rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  text-decoration: none;
  color: var(--text-primary);
  transition: all 0.3s ease;
  cursor: pointer;
  box-shadow: var(--shadow-card);
}

.service-card:hover {
  transform: translateY(-5px);
  box-shadow: var(--shadow-hover);
  border-color: var(--accent-primary);
}

.icon {
  font-size: 4rem;
  margin-bottom: 1rem;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
}

h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

p {
  font-size: 1rem;
  color: var(--text-secondary);
  text-align: center;
}

@media (max-width: 768px) {
  .service-card {
    padding: 2rem 1.5rem;
  }
  
  .icon {
    font-size: 3rem;
    margin-bottom: 0.75rem;
  }
  
  h2 {
    font-size: 1.25rem;
  }
  
  p {
    font-size: 0.9rem;
  }
}

@media (max-width: 480px) {
  .service-card {
    padding: 1.5rem 1rem;
  }
  
  .icon {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
  }
  
  h2 {
    font-size: 1.125rem;
  }
  
  p {
    font-size: 0.875rem;
  }
}
</style>

