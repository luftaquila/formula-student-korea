<template>
  <div class="app">
    <header class="header">
      <h1>Formula Student Korea</h1>
      <ThemeToggle />
    </header>
    <main class="main">
      <div class="services">
        <ServiceCard
          title="Entry"
          description="엔트리 관리 시스템"
          path="/entry"
          icon="📝"
        />
        <ServiceCard
          title="Traffic"
          description="트래픽 관리 시스템"
          path="/traffic"
          icon="🚦"
        />
        <ServiceCard
          title="Energymeter"
          description="에너지미터 뷰어"
          path="/energymeter"
          icon="⚡"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import ServiceCard from './components/ServiceCard.vue'
import ThemeToggle from './components/ThemeToggle.vue'
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  transition: background-color 0.3s ease;
}

.header {
  padding: 2rem;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
}

.header h1 {
  font-size: 2rem;
  font-weight: 700;
  color: white;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  margin: 0;
}

.main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.services {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 2rem;
  max-width: 1200px;
  width: 100%;
}

@media (max-width: 768px) {
  .header {
    padding: 1.5rem;
    flex-direction: column;
    text-align: center;
  }
  
  .header h1 {
    font-size: 1.5rem;
  }
  
  .main {
    padding: 1.5rem 1rem;
  }
  
  .services {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
}

@media (max-width: 480px) {
  .header {
    padding: 1rem;
  }
  
  .header h1 {
    font-size: 1.25rem;
  }
  
  .main {
    padding: 1rem;
  }
  
  .services {
    gap: 1rem;
  }
}
</style>

