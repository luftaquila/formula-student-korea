import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'

// Apply theme on mount
const saved = localStorage.getItem('theme')
if (saved) {
  document.documentElement.setAttribute('data-theme', saved)
} else {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
}

// Listen for theme changes from other services
window.addEventListener('storage', (e) => {
  if (e.key === 'theme') {
    document.documentElement.setAttribute('data-theme', e.newValue || 'light')
  }
})

createApp(App).mount('#app')

