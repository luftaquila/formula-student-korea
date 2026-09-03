<template>
  <div class="dashboard">
    <!-- Stats Cards -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">오늘 전송</div>
        <div class="stat-value">{{ stats.sent ?? '-' }}</div>
      </div>
      <div class="stat-card" :title="quota.error || ''">
        <div class="stat-label">잔량</div>
        <div class="stat-value" :class="{ 'stat-danger': quota.error }">{{ quota.error ? '!' : quota.remaining ?? '-' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">누적 발송</div>
        <div class="stat-value stat-success">{{ stats.totalSent ?? '-' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">누적 오류</div>
        <div class="stat-value stat-danger">{{ stats.totalErrors ?? '-' }}</div>
      </div>
    </div>

    <!-- Email Log Card -->
    <div class="card">
      <div class="card-header">
        <h3>전송 기록</h3>
        <div class="card-header-actions">
          <button class="btn btn-primary btn-sm" @click="showCompose = true">메일 전송</button>
          <select v-model="logFilter" class="form-select" @change="fetchEmailLog(true)">
            <option value="">전체 상태</option>
            <option value="sent">성공</option>
            <option value="error">오류</option>
          </select>
        </div>
      </div>
      <div class="card-body">
        <div v-if="logLoading" class="loading-text">로딩 중...</div>
        <div v-else class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-time">시간</th>
                <th class="col-subject">제목</th>
                <th class="col-shrink">수신자</th>
                <th class="col-shrink">출처</th>
                <th class="col-shrink">상태</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="emailLogs.length === 0">
                <td colspan="5" class="empty-text">전송 기록이 없습니다.</td>
              </tr>
              <tr v-for="log in emailLogs" :key="log.id" class="row-clickable" @click="openLogDetail(log)">
                <td class="col-time">{{ formatTime(log.sent_at) }}</td>
                <td class="col-subject">{{ log.subject }}</td>
                <td class="col-shrink">{{ recipientDisplay(log.recipient) }}</td>
                <td class="col-shrink"><span class="badge badge-primary">{{ log.source }}</span></td>
                <td class="col-shrink">
                  <span class="badge" :class="log.status === 'sent' ? 'badge-success' : 'badge-danger'">
                    {{ log.status === 'sent' ? '성공' : '오류' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="!logLoading && logTotal > 0" class="pagination">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="logPage <= 1" @click="goLogPage(logPage - 1)">이전</button>
          <span class="page-info">{{ logPage }} / {{ logTotalPages }} ({{ logTotal }}건)</span>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="logPage >= logTotalPages" @click="goLogPage(logPage + 1)">다음</button>
        </div>
      </div>
    </div>

    <!-- Config Cards -->
    <div v-if="isAdmin" class="config-row">
      <div class="card">
        <div class="card-header">
          <h3>이메일 설정</h3>
        </div>
        <div class="card-body">
          <div class="form-group form-group-inline">
            <label class="form-label">이메일 활성화</label>
            <label class="toggle-switch" title="이메일 전송 활성화/비활성화">
              <input type="checkbox" :checked="emailEnabled" @change="toggleEmailEnabled" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="form-group">
            <label class="form-label">Brevo API Key</label>
            <input type="password" class="form-input" :placeholder="config.brevo_api_key ? '설정됨' : '미설정'" v-model="configEdit.brevo_api_key" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label">발신자 이름</label>
            <input type="text" class="form-input" :placeholder="config.brevo_sender_name || '미설정'" v-model="configEdit.brevo_sender_name" />
          </div>
          <div class="form-group">
            <label class="form-label">발신자 이메일</label>
            <input type="email" class="form-input" :placeholder="config.brevo_sender_email || '미설정'" v-model="configEdit.brevo_sender_email" />
          </div>
          <div class="config-actions">
            <button class="btn btn-primary btn-sm" @click="saveBrevoConfig" :disabled="brevoSaving">저장</button>
            <button class="btn btn-ghost btn-sm" @click="showEmailTest = !showEmailTest">테스트</button>
            <button class="btn btn-danger btn-sm" @click="handleResetConfig('brevo')">초기화</button>
          </div>
          <div v-if="showEmailTest" class="test-row">
            <input type="email" class="form-input" v-model="emailTestRecipient" placeholder="수신자 이메일" />
            <button class="btn btn-primary btn-sm" @click="handleTestEmail" :disabled="emailTesting || !emailTestRecipient">
              {{ emailTesting ? '전송 중...' : '전송' }}
            </button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>SMS 설정</h3></div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Naver Cloud Access Key</label>
            <input type="password" class="form-input" :placeholder="config.naver_cloud_access_key ? '설정됨' : '미설정'" v-model="configEdit.naver_cloud_access_key" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label">Naver Cloud Secret Key</label>
            <input type="password" class="form-input" :placeholder="config.naver_cloud_secret_key ? '설정됨' : '미설정'" v-model="configEdit.naver_cloud_secret_key" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label">Naver Cloud SMS Service ID</label>
            <input type="text" class="form-input" :placeholder="config.naver_cloud_sms_service_id || '미설정'" v-model="configEdit.naver_cloud_sms_service_id" />
          </div>
          <div class="form-group">
            <label class="form-label">발신자 번호</label>
            <input type="text" class="form-input" :placeholder="config.phone_number_sms_sender || '미설정'" v-model="configEdit.phone_number_sms_sender" />
          </div>
          <div class="config-actions">
            <button class="btn btn-primary btn-sm" @click="saveSmsConfig" :disabled="smsSaving">저장</button>
            <button class="btn btn-ghost btn-sm" @click="showSmsTest = !showSmsTest">테스트</button>
            <button class="btn btn-danger btn-sm" @click="handleResetConfig('sms')">초기화</button>
          </div>
          <div v-if="showSmsTest" class="test-row">
            <input type="tel" class="form-input" v-model="smsTestRecipient" placeholder="수신자 전화번호" />
            <button class="btn btn-primary btn-sm" @click="handleTestSms" :disabled="smsTesting || !smsTestRecipient">
              {{ smsTesting ? '전송 중...' : '전송' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Log Detail Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="selectedLog" class="modal-overlay" @click.self="selectedLog = null" @keydown.escape.window="selectedLog = null">
          <div class="modal-box">
            <div class="modal-header">
              <span class="modal-title">전송 상세</span>
              <button class="modal-close" @click="selectedLog = null">✕</button>
            </div>
            <div class="modal-body">
              <div class="modal-row">
                <span class="modal-label">시간</span>
                <span class="modal-value">{{ formatTime(selectedLog.sent_at) }}</span>
              </div>
              <div class="modal-row">
                <span class="modal-label">제목</span>
                <span class="modal-value">{{ selectedLog.subject }}</span>
              </div>
              <div class="modal-row">
                <span class="modal-label">수신자</span>
                <span class="modal-value">{{ recipientDisplay(selectedLog.recipient) }}</span>
              </div>
              <div class="modal-row">
                <span class="modal-label">출처</span>
                <span class="modal-value"><span class="badge badge-primary">{{ selectedLog.source }}</span></span>
              </div>
              <div class="modal-row">
                <span class="modal-label">상태</span>
                <span class="modal-value">
                  <span class="badge" :class="selectedLog.status === 'sent' ? 'badge-success' : 'badge-danger'">
                    {{ selectedLog.status === 'sent' ? '성공' : '오류' }}
                  </span>
                </span>
              </div>
              <div v-if="selectedLog.message_id" class="modal-row">
                <span class="modal-label">Message ID</span>
                <span class="modal-value mono">{{ selectedLog.message_id }}</span>
              </div>
              <div v-if="selectedLog.error" class="modal-row">
                <span class="modal-label">오류</span>
                <span class="modal-value text-danger">{{ selectedLog.error }}</span>
              </div>
              <div v-if="selectedLog.html_content" class="modal-row modal-row-content">
                <span class="modal-label">내용</span>
                <iframe class="modal-value email-content-frame" :srcdoc="selectedLogSrcdoc" sandbox="" title="메일 내용"></iframe>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Compose Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showCompose" class="modal-overlay" @click.self="showCompose = false" @keydown.escape.window="showCompose = false">
          <div class="modal-box compose-modal">
            <div class="modal-header">
              <span class="modal-title">메일 전송</span>
              <button class="modal-close" @click="showCompose = false">✕</button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label class="form-label">제목</label>
                <input type="text" class="form-input" v-model="compose.subject" placeholder="메일 제목" />
              </div>

              <div class="form-group">
                <label class="form-label">수신자</label>
                <div class="recipient-controls">
                  <select v-model="roleFilter" class="form-select">
                    <option value="">전체 역할</option>
                    <option value="admin">Admin</option>
                    <option value="official">Official</option>
                    <option value="student">Student</option>
                  </select>
                  <select v-model="activeFilter" class="form-select">
                    <option value="active">활성 계정</option>
                    <option value="inactive">비활성 계정</option>
                    <option value="">전체 계정</option>
                  </select>
                  <button class="btn btn-ghost btn-sm" @click="toggleAllRecipients">
                    {{ allFilteredSelected ? '전체 해제' : '전체 선택' }}
                  </button>
                  <span class="recipient-count">{{ compose.recipients.size }}명 선택</span>
                </div>
                <div class="recipient-list" v-if="!recipientLoading">
                  <label v-for="user in filteredRecipients" :key="user.email" class="recipient-item" :class="{ 'recipient-inactive': !user.active }">
                    <input type="checkbox" :checked="compose.recipients.has(user.email)" @change="toggleRecipient(user.email)" />
                    <span class="recipient-left">
                      <span class="recipient-name">{{ user.realname || user.name }}</span>
                      <span class="recipient-email">({{ user.email }})</span>
                    </span>
                    <span class="badge" :class="roleBadgeClass(user.role)">{{ user.role }}</span>
                  </label>
                  <div v-if="filteredRecipients.length === 0" class="empty-text">해당 조건의 수신자가 없습니다.</div>
                </div>
                <div v-else class="loading-text">수신자 로딩 중...</div>
              </div>

              <div class="form-group">
                <label class="form-label">내용 (HTML)</label>
                <textarea class="form-input compose-body" v-model="compose.htmlContent" placeholder="메일 내용을 입력하세요" rows="10"></textarea>
              </div>
            </div>
            <div class="modal-actions">
              <button class="btn btn-ghost" @click="showCompose = false">취소</button>
              <button class="btn btn-primary" @click="handleSend" :disabled="sending || !canSend">
                {{ sending ? '전송 중...' : '전송' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { fetchStats as apiFetchStats, fetchQuota as apiFetchQuota, fetchEmails, fetchEmail, sendEmail, fetchRecipients, fetchConfig as apiFetchConfig, updateConfig, testEmail as apiTestEmail, testSms as apiTestSms, resetConfig as apiResetConfig } from "../api.js";
import { isAdmin } from "@shared/officialsStore.js";

const { success, error: showError } = useNotification();

// ── Stats ──
const stats = ref({ sent: null, errors: null });
const quota = ref({ remaining: null });

async function loadStats() {
  try {
    const [s, q] = await Promise.all([apiFetchStats(), apiFetchQuota()]);
    stats.value = s;
    quota.value = q;
  } catch { /* stats are non-critical */ }
}

// ── Email Log ──
const emailLogs = ref([]);
const logLoading = ref(true);
const logFilter = ref("");
const logPage = ref(1);
const logTotal = ref(0);
const PAGE_SIZE = 10;
const logTotalPages = computed(() => Math.max(1, Math.ceil(logTotal.value / PAGE_SIZE)));
const selectedLog = ref(null);
const EMAIL_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
const selectedLogSrcdoc = computed(() => {
  const html = selectedLog.value?.html_content;
  if (!html) return "";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}"><style>body{margin:12px;font:14px system-ui,sans-serif;color:#111;word-break:break-word;}</style>${html}`;
});

async function fetchEmailLog(reset) {
  if (reset) logPage.value = 1;
  logLoading.value = true;
  try {
    const params = { limit: PAGE_SIZE, offset: (logPage.value - 1) * PAGE_SIZE };
    if (logFilter.value) params.status = logFilter.value;
    const data = await fetchEmails(params);
    emailLogs.value = data.rows;
    logTotal.value = data.total;
  } catch (e) {
    showError(e.message);
  } finally {
    logLoading.value = false;
  }
}

function goLogPage(p) {
  logPage.value = p;
  fetchEmailLog(false);
}

async function openLogDetail(log) {
  selectedLog.value = log;
  try {
    selectedLog.value = await fetchEmail(log.id);
  } catch (e) {
    showError(e.message);
  }
}


// ── Config ──
const config = ref({});
const configEdit = reactive({
  brevo_api_key: "",
  brevo_sender_name: "",
  brevo_sender_email: "",
  naver_cloud_access_key: "",
  naver_cloud_secret_key: "",
  naver_cloud_sms_service_id: "",
  phone_number_sms_sender: "",
});
const brevoSaving = ref(false);
const smsSaving = ref(false);

async function loadConfig() {
  try {
    config.value = await apiFetchConfig();
  } catch { /* non-critical */ }
}

async function saveBrevoConfig() {
  brevoSaving.value = true;
  try {
    const configs = ["brevo_api_key", "brevo_sender_name", "brevo_sender_email"]
      .filter((k) => configEdit[k])
      .map((k) => ({ key: k, value: configEdit[k] }));
    if (configs.length === 0) return showError("변경할 값이 없습니다.");
    await updateConfig(configs);
    success("이메일 설정이 저장되었습니다.");
    for (const k of ["brevo_api_key", "brevo_sender_name", "brevo_sender_email"]) configEdit[k] = "";
    await Promise.all([loadConfig(), loadStats()]);
  } catch (e) {
    showError(e.message);
  } finally {
    brevoSaving.value = false;
  }
}

async function saveSmsConfig() {
  smsSaving.value = true;
  try {
    const configs = ["naver_cloud_access_key", "naver_cloud_secret_key", "naver_cloud_sms_service_id", "phone_number_sms_sender"]
      .filter((k) => configEdit[k])
      .map((k) => ({ key: k, value: configEdit[k] }));
    if (configs.length === 0) return showError("변경할 값이 없습니다.");
    await updateConfig(configs);
    success("SMS 설정이 저장되었습니다.");
    for (const k of ["naver_cloud_access_key", "naver_cloud_secret_key", "naver_cloud_sms_service_id", "phone_number_sms_sender"]) configEdit[k] = "";
    await loadConfig();
  } catch (e) {
    showError(e.message);
  } finally {
    smsSaving.value = false;
  }
}

// ── Test ──
const showEmailTest = ref(false);
const showSmsTest = ref(false);
const emailTestRecipient = ref("");
const smsTestRecipient = ref("");
const emailTesting = ref(false);
const smsTesting = ref(false);

async function handleTestEmail() {
  emailTesting.value = true;
  try {
    await apiTestEmail(emailTestRecipient.value);
    success("테스트 메일이 전송되었습니다.");
    showEmailTest.value = false;
    emailTestRecipient.value = "";
  } catch (e) {
    showError(e.message);
  } finally {
    emailTesting.value = false;
  }
}

async function handleTestSms() {
  smsTesting.value = true;
  try {
    await apiTestSms(smsTestRecipient.value);
    success("테스트 SMS가 전송되었습니다.");
    showSmsTest.value = false;
    smsTestRecipient.value = "";
  } catch (e) {
    showError(e.message);
  } finally {
    smsTesting.value = false;
  }
}

// ── Email Toggle & Config Reset ──
const emailEnabled = computed(() => config.value.email_enabled !== "FALSE");

async function toggleEmailEnabled() {
  try {
    const newVal = emailEnabled.value ? "FALSE" : "TRUE";
    await updateConfig([{ key: "email_enabled", value: newVal }]);
    success(newVal === "TRUE" ? "이메일 전송이 활성화되었습니다." : "이메일 전송이 비활성화되었습니다.");
    await loadConfig();
  } catch (e) {
    showError(e.message);
  }
}

async function handleResetConfig(group) {
  const label = group === "brevo" ? "이메일" : "SMS";
  if (!confirm(`${label} 설정을 모두 초기화하시겠습니까?`)) return;
  try {
    await apiResetConfig(group);
    success(`${label} 설정이 초기화되었습니다.`);
    for (const k of Object.keys(configEdit)) configEdit[k] = "";
    await loadConfig();
  } catch (e) {
    showError(e.message);
  }
}

// ── Compose ──
const showCompose = ref(false);
const sending = ref(false);
const recipientLoading = ref(false);
const recipients = ref([]);
const roleFilter = ref("");
const activeFilter = ref("active");

const compose = reactive({
  subject: "",
  htmlContent: "",
  recipients: new Set(),
});

const filteredRecipients = computed(() => {
  let list = recipients.value;
  if (roleFilter.value) list = list.filter((u) => u.role === roleFilter.value);
  if (activeFilter.value === "active") list = list.filter((u) => u.active);
  else if (activeFilter.value === "inactive") list = list.filter((u) => !u.active);
  return list;
});

const allFilteredSelected = computed(() => {
  return filteredRecipients.value.length > 0 && filteredRecipients.value.every((u) => compose.recipients.has(u.email));
});

const canSend = computed(() => {
  return compose.subject.trim() && compose.htmlContent.trim() && compose.recipients.size > 0;
});

function toggleRecipient(email) {
  const s = new Set(compose.recipients);
  if (s.has(email)) s.delete(email);
  else s.add(email);
  compose.recipients = s;
}

function toggleAllRecipients() {
  const s = new Set(compose.recipients);
  if (allFilteredSelected.value) {
    for (const u of filteredRecipients.value) s.delete(u.email);
  } else {
    for (const u of filteredRecipients.value) s.add(u.email);
  }
  compose.recipients = s;
}

async function handleSend() {
  if (!confirm(`${compose.recipients.size}명에게 메일을 전송하시겠습니까?`)) return;
  sending.value = true;
  try {
    // Pre-send quota check
    const q = await apiFetchQuota();
    if (q.remaining !== null && q.remaining < compose.recipients.size) {
      showError(`전송 가능한 메일 수(${q.remaining}건)가 수신자 수(${compose.recipients.size}명)보다 적습니다.`);
      return;
    }

    await sendEmail({
      subject: compose.subject,
      htmlContent: compose.htmlContent,
      recipients: [...compose.recipients],
    });
    success("메일이 전송되었습니다.");
    showCompose.value = false;
    compose.subject = "";
    compose.htmlContent = "";
    compose.recipients = new Set();
    await Promise.all([fetchEmailLog(true), loadStats()]);
  } catch (e) {
    showError(e.message);
  } finally {
    sending.value = false;
  }
}

watch(showCompose, async (open) => {
  if (open && recipients.value.length === 0) {
    recipientLoading.value = true;
    try {
      recipients.value = await fetchRecipients();
    } catch (e) {
      showError("수신자 목록을 불러올 수 없습니다.");
    } finally {
      recipientLoading.value = false;
    }
  }
});

// ── Util ──
const ROLE_BADGE = { admin: "badge-danger", official: "badge-primary", student: "badge-success" };
function roleBadgeClass(role) { return ROLE_BADGE[role] || "badge-primary"; }

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function recipientDisplay(email) {
  const user = recipients.value.find((u) => u.email === email);
  return user?.realname ? `${user.realname} (${email})` : email;
}

// ── Init ──
onMounted(async () => {
  loadStats();
  fetchEmailLog(false);
  try { recipients.value = await fetchRecipients(); } catch { /* non-critical */ }
  if (isAdmin.value) loadConfig();
});
</script>

<style scoped>
/* Stats */
.stats-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
}

@media (min-width: 640px) {
  .stats-row {
    grid-template-columns: repeat(4, 1fr);
  }
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 1rem;
}

.stat-label {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
  margin-top: 0.25rem;
}

.stat-success {
  color: var(--accent-success);
}

.stat-danger {
  color: var(--accent-danger);
}

/* Card header */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.card-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Table */
.table-wrapper {
  overflow-x: auto;
}

.data-table {
  min-width: 640px;
}

.col-time {
  width: 1%;
  white-space: nowrap;
}

.col-subject {
  white-space: nowrap;
}

.col-shrink {
  width: 1%;
  white-space: nowrap;
}

.text-center {
  text-align: center;
}

.text-danger {
  color: var(--accent-danger);
}

.row-clickable {
  cursor: pointer;
}

.row-clickable:hover {
  background: var(--bg-hover);
}

.empty-text {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

.loading-text {
  text-align: center;
  color: var(--text-secondary);
  padding: 2rem;
}

/* Pagination */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1rem 0 0;
}

.page-info {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background-color: var(--border-color);
  border-radius: 11px;
  transition: background-color 0.2s;
}

.toggle-slider::before {
  content: "";
  position: absolute;
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background-color: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--accent-success);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(18px);
}

/* Config */
.config-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-top: 1.5rem;
}

.config-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.test-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-color);
}

.test-row .form-input {
  flex: 1;
  min-width: 0;
}

.test-row .btn {
  flex-shrink: 0;
}

.form-group {
  margin-bottom: 0.75rem;
}

.form-group-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-group-inline .form-label {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 0.25rem;
}

/* Compose Modal */
.compose-modal {
  max-width: 640px;
  width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
}

.recipient-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.recipient-controls .form-select {
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
}

.card-header-actions .form-select {
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
}

.recipient-count {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  margin-left: auto;
}

.recipient-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.25rem;
}

.recipient-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8125rem;
}

.recipient-item:hover {
  background: var(--bg-hover);
}

.recipient-inactive {
  opacity: 0.5;
}

.recipient-left {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  overflow: hidden;
}

.recipient-name {
  font-weight: 500;
  white-space: nowrap;
}

.recipient-email {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compose-body {
  min-height: 200px;
  resize: vertical;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border-color);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal-box {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0.25rem;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 1.25rem;
}

.modal-row {
  display: flex;
  gap: 0.75rem;
  padding: 0.375rem 0;
  font-size: 0.875rem;
}

.modal-label {
  flex-shrink: 0;
  width: 80px;
  color: var(--text-secondary);
  font-weight: 500;
}

.modal-value {
  word-break: break-all;
}

.modal-row-content {
  flex-direction: column;
  gap: 0.5rem;
}

.modal-row-content .modal-label {
  width: auto;
}

.email-content-frame {
  width: 100%;
  min-height: 300px;
  max-height: 300px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
}

.mono {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.15s ease;
}

.modal-enter-active .modal-box,
.modal-leave-active .modal-box {
  transition: transform 0.15s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-box,
.modal-leave-to .modal-box {
  transform: translateY(10px);
}

/* Responsive */
@media (max-width: 768px) {
  .config-row {
    grid-template-columns: 1fr;
  }

  .card-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .card-header-actions {
    width: 100%;
  }

  .card-header-actions .btn {
    flex: 1;
  }

  .compose-modal {
    max-width: none;
    width: 100%;
    max-height: 100vh;
    border-radius: 0;
    margin: 0;
  }

  .modal-overlay:has(.compose-modal) {
    align-items: flex-end;
    padding: 0;
  }

  .recipient-left {
    flex-direction: column;
    gap: 0;
  }
}

@media (min-width: 769px) and (max-width: 1024px) {
  .config-row {
    grid-template-columns: 1fr;
  }
}
</style>
