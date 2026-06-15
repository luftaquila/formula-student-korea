import { createRouter, createWebHistory } from "vue-router";
import { useSerialStore } from "../stores/serial";
import { useWirelessStore } from "../stores/wireless";

const routes = [
  {
    path: "/",
    redirect: "/record",
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
    path: "/wireless/gymkhana",
    name: "WirelessGymkhana",
    component: () => import("../views/WirelessGymkhanaView.vue"),
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
  // 무선: 브리지(콘솔) 탭에서 점유 중인 경기의 신호등이 green이면 그 이벤트 화면을 못 떠나게 막는다.
  const wireless = useWirelessStore();
  if (
    wireless.bridgeIsSelf &&
    wireless.ownerKey &&
    wireless.lightColorFor(wireless.ownerKey) === "green" &&
    from.path.startsWith("/wireless/") &&
    to.path !== from.path
  ) {
    return false;
  }
});

export default router;
