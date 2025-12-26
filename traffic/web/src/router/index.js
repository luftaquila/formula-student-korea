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
  },
  {
    path: '/entry',
    name: 'Entry',
    component: () => import('../views/EntryView.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
