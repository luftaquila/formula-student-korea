import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    redirect: '/accel'
  },
  {
    path: '/accel',
    name: 'Accel',
    component: () => import('../views/AccelView.vue')
  },
  {
    path: '/gymkhana',
    name: 'Gymkhana',
    component: () => import('../views/GymkhanaView.vue')
  },
  {
    path: '/skidpad',
    name: 'Skidpad',
    component: () => import('../views/SkidpadView.vue')
  },
  {
    path: '/record',
    name: 'Record',
    component: () => import('../views/RecordView.vue')
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? import.meta.env.BASE_URL : ''),
  routes
})

export default router
