<script setup>
import { computed, onMounted, ref } from "vue";
import { hasPermission } from "@shared/officialsStore.js";
import { useNotification } from "@shared/useNotification.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const { success, error } = useNotification();
const contacts = ref([]);
const candidates = ref([]);
const selectedId = ref("");
const loading = ref(true);

if (!hasPermission("contacts.manage")) window.location.href = "/";

const available = computed(() => {
  const selected = new Set(contacts.value.map((contact) => contact.id));
  return candidates.value.filter((candidate) => !selected.has(candidate.id));
});

async function request(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  if (!response.ok) throw new Error(await response.text() || "요청을 처리하지 못했습니다.");
  return response;
}

async function load() {
  loading.value = true;
  try {
    const [contactsResponse, candidatesResponse] = await Promise.all([
      request("/api/ops-contacts"),
      request("/api/contact-candidates"),
    ]);
    contacts.value = await contactsResponse.json();
    candidates.value = await candidatesResponse.json();
    selectedId.value = "";
  } catch (cause) {
    error(cause.message);
  } finally {
    loading.value = false;
  }
}

async function addContact() {
  const userId = Number(selectedId.value);
  if (!userId) return;
  try {
    await request("/api/ops-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    success("운영 연락처를 추가했습니다.");
    await load();
  } catch (cause) { error(cause.message); }
}

async function saveDescription(contact, value) {
  const description = value.trim();
  if (description === (contact.description || "")) return;
  try {
    const response = await request(`/api/ops-contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    contact.description = (await response.json()).description;
  } catch (cause) { error(cause.message); }
}

async function reorder(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= contacts.value.length) return;
  const reordered = [...contacts.value];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  try {
    await request("/api/ops-contacts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_ids: reordered.map((contact) => contact.id) }),
    });
    contacts.value = reordered;
  } catch (cause) { error(cause.message); }
}

async function removeContact(contact) {
  if (!confirm(`${contact.realname || contact.name || contact.email} 연락처를 제거할까요?`)) return;
  try {
    await request(`/api/ops-contacts/${contact.id}`, { method: "DELETE" });
    success("운영 연락처를 제거했습니다.");
    await load();
  } catch (cause) { error(cause.message); }
}

onMounted(load);
</script>

<template>
  <div class="contacts-page">
    <section class="card add-card">
      <h3>연락처 추가</h3>
      <form @submit.prevent="addContact">
        <select v-model="selectedId" class="form-select" required>
          <option value="" disabled>Official 또는 Admin 선택</option>
          <option v-for="candidate in available" :key="candidate.id" :value="candidate.id">
            {{ candidate.realname || candidate.name || candidate.email }} · {{ candidate.email }}
          </option>
        </select>
        <button class="btn btn-primary" :disabled="!selectedId">추가</button>
      </form>
    </section>

    <section class="card contacts-card">
      <h3>사이드바 표시 순서</h3>
      <div v-if="loading" class="empty-state">불러오는 중…</div>
      <div v-else-if="!contacts.length" class="empty-state">표시할 연락처가 없습니다.</div>
      <div v-else class="contact-list">
        <div v-for="(contact, index) in contacts" :key="contact.id" class="contact-row">
          <div class="order-actions">
            <button class="btn btn-sm btn-ghost" :disabled="index === 0" aria-label="위로 이동" @click="reorder(index, -1)">↑</button>
            <button class="btn btn-sm btn-ghost" :disabled="index === contacts.length - 1" aria-label="아래로 이동" @click="reorder(index, 1)">↓</button>
          </div>
          <div class="identity">
            <strong>{{ contact.realname || contact.name || contact.email }}</strong>
            <small>{{ contact.email }}<template v-if="contact.phone"> · {{ contact.phone }}</template></small>
          </div>
          <input
            class="form-input description"
            :value="contact.description || ''"
            maxlength="30"
            placeholder="역할 설명"
            @blur="saveDescription(contact, $event.target.value)"
            @keyup.enter="$event.target.blur()"
          />
          <button class="btn btn-sm btn-danger" @click="removeContact(contact)">제거</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.contacts-page { display: grid; gap: 1rem; }
.card { padding: 1.25rem; }
.add-card form { display: flex; gap: 0.75rem; margin-top: 1rem; }
.add-card select { flex: 1; }
.contact-list { display: grid; margin-top: 1rem; }
.contact-row { display: grid; grid-template-columns: auto minmax(12rem, 1fr) minmax(10rem, 1fr) auto; gap: 0.75rem; align-items: center; padding: 0.75rem 0; border-top: 1px solid var(--border-color); }
.order-actions { display: flex; gap: 0.25rem; }
.identity { display: grid; }
.identity small { color: var(--text-secondary); }
.empty-state { padding: 2rem; color: var(--text-secondary); text-align: center; }
@media (max-width: 700px) {
  .contact-row { grid-template-columns: auto 1fr auto; }
  .description { grid-column: 1 / -1; grid-row: 2; }
}
</style>
