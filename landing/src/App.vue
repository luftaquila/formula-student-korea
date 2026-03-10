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
      <section class="section">
        <h2 class="section-title">Services</h2>
        <div class="services">
          <ServiceCard title="검차 대기열" description="" path="/queue" icon="🔧" />
          <ServiceCard title="에너지미터" description="" path="/energymeter" icon="⚡" />
          <ServiceCard title="대회 규정집" description="" path="/rules" icon="📖" external />
          <ServiceCard
            title="자작자동차포럼"
            description=""
            path="https://dnf.luftaquila.io"
            :svgIcon="forumSvg"
            external
          />
        </div>
      </section>

      <section v-if="showOfficials" class="section">
        <h2 class="section-title">Officials</h2>
        <div class="services">
          <ServiceCard title="엔트리 관리" description="" path="/entry" icon="🏁" />
          <ServiceCard title="검차 대기 관리" description="" path="/queue/admin" icon="🛠️" />
          <ServiceCard title="인스펙션 시트" description="" path="/inspection" icon="📋" />
          <ServiceCard title="계측 시스템" description="" path="/traffic" icon="🚦" />
          <ServiceCard title="성적 관리" description="" path="/score" icon="📊" />
          <ServiceCard title="클라우드" description="" path="https://cloud.fsk.luftaquila.io" icon="☁️" external />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import ServiceCard from "./components/ServiceCard.vue";
import ThemeToggle from "./components/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";
import { showOfficials } from "@shared/officialsStore.js";
import { forumSvg } from "@shared/nav-config.js";
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  gap: 3rem;
}

.section {
  width: 100%;
  max-width: 1200px;
}

.section-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 1.5rem;
  padding-left: 0.5rem;
  border-left: 3px solid var(--accent-primary);
}

.services {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1.5rem;
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

  .main {
    padding: 2.5rem 1rem;
    gap: 2rem;
    justify-content: flex-start;
  }

  .section-title {
    font-size: 1.125rem;
  }

  .services {
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }
}

@media (max-width: 480px) {
  .main {
    padding: 1rem;
    gap: 1.5rem;
  }
}
</style>
