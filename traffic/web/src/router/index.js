import { createRouter, createWebHistory } from "vue-router";
import { useSerialStore } from "../stores/serial";

const routes = [
  {
    path: "/",
    redirect: "/record",
  },
  {
    path: "/accel",
    name: "Accel",
    component: () => import("../views/AccelView.vue"),
  },
  {
    path: "/skidpad",
    name: "Skidpad",
    component: () => import("../views/SkidpadView.vue"),
  },
  {
    path: "/autocross",
    name: "Autocross",
    component: () => import("../views/AutocrossView.vue"),
  },
  {
    path: "/gymkhana",
    name: "Gymkhana",
    component: () => import("../views/GymkhanaView.vue"),
  },
  {
    path: "/record",
    name: "Record",
    component: () => import("../views/RecordView.vue"),
  },
  {
    path: "/scoreboard",
    name: "Scoreboard",
    component: () => import("../views/ScoreboardView.vue"),
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.PROD ? import.meta.env.BASE_URL : ""),
  routes,
});

router.beforeEach((to, from) => {
  const serial = useSerialStore();
  if (serial.green.active && to.path !== from.path) {
    return false;
  }
});

export default router;
