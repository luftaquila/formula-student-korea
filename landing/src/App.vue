<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🏁</span>
          <h1>Formula Student Korea</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu currentPath="/" />
        </div>
      </div>
    </header>
    <main class="main">
      <div class="services">
        <ServiceCard title="Entry" description="엔트리 관리 시스템" path="/entry" icon="📝" />
        <ServiceCard title="Traffic" description="트래픽 관리 시스템" path="/traffic" icon="🚦" />
        <ServiceCard title="Energymeter" description="에너지미터 뷰어" path="/energymeter" icon="⚡" />
      </div>
    </main>
  </div>
</template>

<script setup>
import ServiceCard from "./components/ServiceCard.vue";
import ThemeToggle from "./components/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";
</script>

<style scoped>
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  transition: background-color 0.3s ease;
}

.header {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  padding: 1rem 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.header-content {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}

.logo-icon {
  font-size: 2rem;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.logo h1 {
  color: white;
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
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
    padding: 1rem;
  }

  .header-content {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }

  .logo h1 {
    font-size: 1.25rem;
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

  .logo h1 {
    font-size: 1.125rem;
  }

  .main {
    padding: 1rem;
  }

  .services {
    gap: 1rem;
  }
}
</style>
