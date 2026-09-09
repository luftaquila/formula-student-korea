import { createRouter, createWebHistory } from "vue-router";
import { useSerialStore } from "../stores/serial";
import { hasPermission } from "@shared/browser/officialsStore.js";

const routes = [
  {
    // 계측 시스템 진입 시 무선 계측 모드를 기본으로 보여준다(유선은 헤더 버튼으로 전환).
    path: "/",
    redirect: "/wireless",
  },
  {
    path: "/wireless",
    redirect: "/wireless/record",
  },
  {
    path: "/wireless/record",
    name: "WirelessRecord",
    component: () => import("../views/RecordView.vue"),
  },
  {
    path: "/wireless/settings",
    name: "WirelessSettings",
    component: () => import("../views/WirelessHomeView.vue"),
    meta: { permission: "traffic.manage" },
  },
  {
    path: "/wireless/scoreboard",
    name: "WirelessScoreboard",
    component: () => import("../views/ScoreboardView.vue"),
  },
  {
    path: "/wireless/accel",
    name: "WirelessAccel",
    component: () => import("../views/WirelessAccelView.vue"),
  },
  {
    path: "/wireless/skidpad",
    name: "WirelessSkidpad",
    component: () => import("../views/WirelessSkidpadView.vue"),
  },
  {
    path: "/wireless/autocross",
    name: "WirelessAutocross",
    component: () => import("../views/WirelessAutocrossView.vue"),
  },
  {
    path: "/wireless/endurance",
    name: "WirelessEndurance",
    component: () => import("../views/WirelessEnduranceView.vue"),
  },
  {
    path: "/accel",
    name: "Accel",
    component: () => import("../views/StartFinishView.vue"),
    props: { config: { mode: "accel", type: "가속", defaultTitle: "Acceleration" } },
  },
  {
    path: "/skidpad",
    name: "Skidpad",
    component: () => import("../views/SkidpadView.vue"),
  },
  {
    path: "/autocross",
    name: "Autocross",
    component: () => import("../views/StartFinishView.vue"),
    props: { config: { mode: "autocross", type: "오토크로스", defaultTitle: "Autocross" } },
  },
  {
    path: "/endurance",
    name: "Endurance",
    component: () => import("../views/EnduranceView.vue"),
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
  if (to.meta.permission && !hasPermission(to.meta.permission)) return "/wireless/record";
  const serial = useSerialStore();
  if (serial.green.active && to.path !== from.path) {
    return false;
  }

});

export default router;
