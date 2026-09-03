<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { isAdmin } from "@shared/officialsStore.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";
import { useNotification } from "@shared/useNotification.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const { success, error } = useNotification();
const devices = ref([]);
// Server status keys rendered in the page's language.
const DEVICE_STATUS_LABELS = { active: "활성", pending: "페어링 대기", revoked: "폐기", unpaired: "미페어링" };
const name = ref("");
const scope = ref("kiosk.queue.register");
const issued = ref(null);
const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 1000);

if (!isAdmin.value) window.location.href = "/";

function scopeLabel(value) {
  return value === "kiosk.queue.register" ? "검차 대기 접수" : "등록 대기 접수";
}

function formatTimestamp(value) {
  const parsed = parseDbTimestamp(value);
  return parsed ? parsed.toLocaleString("ko-KR") : "-";
}

function expiresIn(value) {
  const seconds = Math.max(0, Math.ceil((Date.parse(value) - now.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function load() {
  const response = await fetch(`${BASE_URL}/api/devices`);
  if (!response.ok) return error("장비 목록을 불러오지 못했습니다.");
  devices.value = await response.json();
}

async function createDevice() {
  const response = await fetch(`${BASE_URL}/api/devices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.value, scope: scope.value }),
  });
  if (!response.ok) return error("장비를 생성하지 못했습니다.");
  issued.value = await response.json();
  name.value = "";
  success("장비 코드를 생성했습니다.");
  await load();
}

async function reissue(device) {
  if (!confirm(`${device.name}의 새 페어링 코드를 발급하시겠습니까?`)) return;
  const response = await fetch(`${BASE_URL}/api/devices/${device.id}/pairing-code`, { method: "POST" });
  if (!response.ok) return error("코드를 발급하지 못했습니다.");
  issued.value = { ...device, ...(await response.json()) };
  await load();
}

async function revoke(device) {
  if (!confirm(`${device.name} 장비 인증을 폐기하시겠습니까?`)) return;
  const response = await fetch(`${BASE_URL}/api/devices/${device.id}/revoke`, { method: "POST" });
  if (!response.ok) return error("장비를 폐기하지 못했습니다.");
  success("장비 인증을 폐기했습니다.");
  if (issued.value?.id === device.id) issued.value = null;
  await load();
}

onMounted(load);
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="device-page">
    <section class="card device-create">
      <h3>접수 전용 태블릿 추가</h3>
      <form @submit.prevent="createDevice">
        <input v-model="name" class="form-input" maxlength="80" placeholder="장비 이름" required />
        <select v-model="scope" class="form-select">
          <option value="kiosk.queue.register">검차 대기 접수</option>
          <option value="kiosk.registration.register">등록 대기 접수</option>
        </select>
        <button class="btn btn-primary">코드 생성</button>
      </form>
    </section>

    <section v-if="issued" class="card issued-card">
      <strong>{{ issued.name }} 일회용 코드</strong>
      <div class="issued-code">{{ issued.pairingCode }}</div>
      <span>{{ scopeLabel(issued.scope) }} · {{ expiresIn(issued.pairingCodeExpiresAt) }} 후 만료</span>
      <p>이 코드는 다시 표시되지 않습니다.</p>
    </section>

    <section class="card">
      <h3>등록된 장비</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>이름</th><th>용도</th><th>상태</th><th>페어링</th><th>최근 사용</th><th></th></tr></thead>
          <tbody>
            <tr v-for="device in devices" :key="device.id">
              <td>{{ device.name }}</td>
              <td>{{ scopeLabel(device.scope) }}</td>
              <td>{{ DEVICE_STATUS_LABELS[device.status] || device.status }}</td>
              <td>{{ device.pairedAt ? formatTimestamp(device.pairedAt) : "-" }}</td>
              <td>{{ device.lastSeenAt ? formatTimestamp(device.lastSeenAt) : "-" }}</td>
              <td class="actions">
                <button class="btn btn-sm btn-ghost" @click="reissue(device)">코드 재발급</button>
                <button class="btn btn-sm btn-danger" :disabled="device.status === 'revoked'" @click="revoke(device)">폐기</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.device-page { display: grid; gap: 1.5rem; }
.card { padding: 1.25rem; }
.device-create form { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.device-create input { flex: 1 1 240px; }
.issued-card { text-align: center; border-color: var(--accent-primary); }
.issued-code { margin: 1rem; font: 800 2.5rem/1 monospace; letter-spacing: 0.25em; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.7rem; border-bottom: 1px solid var(--border-color); text-align: left; }
.actions { display: flex; gap: 0.5rem; white-space: nowrap; }
</style>
