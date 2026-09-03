<script setup>
import "temporal-polyfill/global";
import { ref, onMounted, onUnmounted } from "vue";
import { ScheduleXCalendar } from "@schedule-x/vue";
import { createCalendar, viewMonthGrid, viewMonthAgenda } from "@schedule-x/calendar";
import { createEventsServicePlugin } from "@schedule-x/events-service";
import { createEventModalPlugin } from "@schedule-x/event-modal";
import "@schedule-x/theme-default/dist/index.css";
import { isAuthenticated, isChief } from "@shared/officialsStore.js";
import { useNotification } from "@shared/useNotification.js";
import { request } from "../api.js";
import EventModal from "../components/EventModal.vue";

const { notyf } = useNotification();

const showEventModal = ref(false);
const editingEvent = ref(null);
const rangeHeading = ref("");
const selectedAgendaDate = ref("");
const isMobile = ref(window.innerWidth < 768);
const showSubscribe = ref(false);
const subscribeUrl = ref("");
const copied = ref(false);

const ROLE_CALENDARS = {
  public: {
    colorName: "public",
    label: "public",
    lightColors: { main: "#64748b", container: "#f1f5f9", onContainer: "#334155" },
    darkColors: { main: "#94a3b8", container: "#334155", onContainer: "#e2e8f0" },
  },
  student: {
    colorName: "student",
    label: "student",
    lightColors: { main: "#059669", container: "#d1fae5", onContainer: "#065f46" },
    darkColors: { main: "#6ee7b7", container: "#064e3b", onContainer: "#d1fae5" },
  },
  staff: {
    colorName: "staff",
    label: "staff",
    lightColors: { main: "#0d9488", container: "#ccfbf1", onContainer: "#115e59" },
    darkColors: { main: "#5eead4", container: "#134e4a", onContainer: "#ccfbf1" },
  },
  official: {
    colorName: "official",
    label: "official",
    lightColors: { main: "#3b82f6", container: "rgba(59, 130, 246, 0.15)", onContainer: "#1d4ed8" },
    darkColors: { main: "#60a5fa", container: "#1e3a5f", onContainer: "#bfdbfe" },
  },
  chief: {
    colorName: "chief",
    label: "chief",
    lightColors: { main: "#d97706", container: "#fef3c7", onContainer: "#92400e" },
    darkColors: { main: "#fcd34d", container: "#78350f", onContainer: "#fef3c7" },
  },
  master: {
    colorName: "master",
    label: "master",
    lightColors: { main: "#7c3aed", container: "#ede9fe", onContainer: "#5b21b6" },
    darkColors: { main: "#c4b5fd", container: "#4c1d95", onContainer: "#ede9fe" },
  },
  admin: {
    colorName: "admin",
    label: "admin",
    lightColors: { main: "#dc2626", container: "#fee2e2", onContainer: "#991b1b" },
    darkColors: { main: "#fca5a5", container: "#7f1d1d", onContainer: "#fee2e2" },
  },
};

const eventsServicePlugin = createEventsServicePlugin();
const eventModalPlugin = createEventModalPlugin();

const calendarApp = createCalendar({
  views: [viewMonthGrid, viewMonthAgenda],
  defaultView: window.innerWidth < 768 ? "month-agenda" : "month-grid",
  locale: "ko-KR",
  monthGridOptions: { nEventsPerDay: 100 },
  firstDayOfWeek: 7,
  isDark: document.documentElement.dataset.theme === "dark",
  calendars: ROLE_CALENDARS,
  callbacks: {
    onRangeUpdate(range) {
      const start = toDateString(range.start);
      const end = toDateString(range.end);
      if (start && end) {
        loadEvents(start, end);
        const mid = new Date((new Date(start + "T00:00:00").getTime() + new Date(end + "T00:00:00").getTime()) / 2);
        rangeHeading.value = `${mid.getFullYear()}년 ${mid.getMonth() + 1}월`;
      }
    },
    onClickDate(date) {
      const dateStr = toDateString(date);
      if (!dateStr) return;
      if (isChief.value) {
        editingEvent.value = { title: "", start: dateStr, end: dateStr, allDay: true, role: "official" };
        showEventModal.value = true;
      }
    },
    onClickAgendaDate(date) {
      selectedAgendaDate.value = toDateString(date);
    },
  },
  plugins: [eventsServicePlugin, eventModalPlugin],
});

function toDateString(temporal) {
  if (!temporal) return "";
  if (typeof temporal === "string") return temporal.slice(0, 10);
  try {
    return temporal.toString().slice(0, 10);
  } catch {
    return "";
  }
}

function toTemporal(dateStr) {
  if (!dateStr) return Temporal.Now.plainDateISO();
  const s = String(dateStr);
  if (s.length === 10) return Temporal.PlainDate.from(s);
  try {
    if (/[zZ]$/.test(s)) return Temporal.Instant.from(s).toZonedDateTimeISO("Asia/Seoul");
    return Temporal.ZonedDateTime.from(s.replace(" ", "T"));
  } catch {
    return Temporal.PlainDate.from(s.slice(0, 10));
  }
}

function initHeading() {
  const now = new Date();
  rangeHeading.value = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;
}

function openAddForDate() {
  const d = selectedAgendaDate.value || new Date().toISOString().slice(0, 10);
  editingEvent.value = { title: "", start: d, end: d, allDay: true, role: "official" };
  showEventModal.value = true;
}

function onResize() {
  isMobile.value = window.innerWidth < 768;
}

function formatPopupDate(event) {
  const startStr = String(event.start).slice(0, 10);
  const endStr = String(event.end).slice(0, 10);
  const opts = { year: "numeric", month: "long", day: "numeric" };
  let result = new Date(startStr + "T00:00:00").toLocaleDateString("ko-KR", opts);

  if (!event.allDay) {
    const st = String(event.start).match(/(\d{2}:\d{2})/);
    if (st) result += ` ${formatTime(st[1])}`;
  }

  if (startStr !== endStr) {
    result += ` ~ ${new Date(endStr + "T00:00:00").toLocaleDateString("ko-KR", opts)}`;
    if (!event.allDay) {
      const et = String(event.end).match(/(\d{2}:\d{2})/);
      if (et) result += ` ${formatTime(et[1])}`;
    }
  } else if (!event.allDay) {
    const et = String(event.end).match(/(\d{2}:\d{2})/);
    if (et) result += ` ~ ${formatTime(et[1])}`;
  }

  return result;
}

function formatTime(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":");
  const hour = parseInt(h);
  const period = hour < 12 ? "오전" : "오후";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${period} ${displayHour}:${m}`;
}

function openEditFromPopup(calendarEvent) {
  const raw = { ...calendarEvent };
  eventModalPlugin.close();
  editingEvent.value = raw;
  showEventModal.value = true;
}

async function loadEvents(start, end) {
  try {
    // Pad range by 7 days each side to cover overflow days in month grid
    const startDate = new Date(start + "T00:00:00");
    startDate.setDate(startDate.getDate() - 7);
    const timeMin = startDate.toISOString().slice(0, 10);
    const endDate = new Date(end + "T00:00:00");
    endDate.setDate(endDate.getDate() + 7);
    const timeMax = endDate.toISOString().slice(0, 10);
    const res = await request(`/api/events?timeMin=${timeMin}&timeMax=${timeMax}`);
    const events = (await res.json()).map(e => ({
      ...e,
      start: toTemporal(e.start),
      end: toTemporal(e.end),
    }));
    eventsServicePlugin.set(events);
  } catch (e) {
    console.error("Failed to load events:", e);
  }
}

async function handleSave(eventData) {
  try {
    if (eventData.id) {
      const res = await request(`/api/events/${eventData.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventData),
      });
      const updated = await res.json();
      eventsServicePlugin.update({ ...updated, start: toTemporal(updated.start), end: toTemporal(updated.end) });
      notyf.success("일정이 수정되었습니다.");
    } else {
      const res = await request("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventData),
      });
      const created = await res.json();
      eventsServicePlugin.add({ ...created, start: toTemporal(created.start), end: toTemporal(created.end) });
      notyf.success("일정이 추가되었습니다.");
    }
    showEventModal.value = false;
  } catch {
    notyf.error("일정 저장에 실패했습니다.");
  }
}

async function handleDelete(eventId) {
  try {
    await request(`/api/events/${eventId}`, { method: "DELETE" });
    eventsServicePlugin.remove(eventId);
    showEventModal.value = false;
    notyf.success("일정이 삭제되었습니다.");
  } catch {
    notyf.error("일정 삭제에 실패했습니다.");
  }
}

async function openSubscribe() {
  try {
    const res = await request("/api/events/subscribe");
    const { path } = await res.json();
    subscribeUrl.value = `${window.location.origin}${path}`;
    copied.value = false;
    showSubscribe.value = true;
  } catch {
    notyf.error("구독 URL 생성에 실패했습니다.");
  }
}

async function copySubscribeUrl() {
  try {
    await navigator.clipboard.writeText(subscribeUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    notyf.error("클립보드 복사에 실패했습니다.");
  }
}

const themeObserver = new MutationObserver(() => {
  calendarApp.setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
});

onMounted(() => {
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", onResize);

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10);
  loadEvents(start, end);

  initHeading();
});

onUnmounted(() => {
  themeObserver.disconnect();
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div class="calendar-container">
    <ScheduleXCalendar :calendar-app="calendarApp">
      <template #headerContentLeftAppend>
        <span class="custom-range-heading">{{ rangeHeading }}</span>
      </template>

      <template #headerContentRightPrepend>
        <button v-if="isAuthenticated" class="subscribe-btn" @click="openSubscribe" title="Google Calendar 연동">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="14" height="14" rx="2" /><path d="M3 8h14M7 2v4M13 2v4" />
            <path d="M10 11v4M8 13h4" />
          </svg>
        </button>
      </template>

      <template #monthAgendaEvent="{ calendarEvent }">
        <div class="agenda-event-inner" :style="{
          backgroundColor: `var(--sx-color-${calendarEvent.calendarId}-container)`,
          color: `var(--sx-color-on-${calendarEvent.calendarId}-container)`,
          borderInlineStart: `4px solid var(--sx-color-${calendarEvent.calendarId})`,
        }">
          <div class="sx__month-agenda-event__title">{{ calendarEvent.title }}</div>
          <div class="agenda-event__row">
            <svg class="agenda-event__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="4" width="14" height="14" rx="2" /><path d="M3 8h14M7 2v4M13 2v4" />
            </svg>
            <span>{{ formatPopupDate(calendarEvent) }}</span>
          </div>
          <div v-if="calendarEvent.location" class="agenda-event__row">
            <svg class="agenda-event__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M10 17s-5-4.35-5-8a5 5 0 1110 0c0 3.65-5 8-5 8z" /><circle cx="10" cy="9" r="1.5" />
            </svg>
            <span>{{ calendarEvent.location }}</span>
          </div>
          <div v-if="calendarEvent.description" class="agenda-event__row agenda-event__desc">
            <svg class="agenda-event__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 5h12M4 8h12M4 11h8M4 14h10" />
            </svg>
            <span>{{ calendarEvent.description }}</span>
          </div>
        </div>
      </template>

      <template #eventModal="{ calendarEvent }">
        <div class="event-popup">
          <div class="event-popup__header">
            <span class="event-popup__role" :class="'role-' + calendarEvent.calendarId">{{ calendarEvent.calendarId }}</span>
            <span class="event-popup__title">{{ calendarEvent.title }}</span>
          </div>

          <div class="event-popup__row">
            <svg class="event-popup__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="4" width="14" height="14" rx="2" /><path d="M3 8h14M7 2v4M13 2v4" />
            </svg>
            <span>{{ formatPopupDate(calendarEvent) }}</span>
          </div>

          <div v-if="calendarEvent.location" class="event-popup__row">
            <svg class="event-popup__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M10 17s-5-4.35-5-8a5 5 0 1110 0c0 3.65-5 8-5 8z" /><circle cx="10" cy="9" r="1.5" />
            </svg>
            <span>{{ calendarEvent.location }}</span>
          </div>

          <div v-if="calendarEvent.description" class="event-popup__row event-popup__desc">
            <svg class="event-popup__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 5h12M4 8h12M4 11h8M4 14h10" />
            </svg>
            <span>{{ calendarEvent.description }}</span>
          </div>

          <button v-if="isChief" class="event-popup__edit-btn" @click="openEditFromPopup(calendarEvent)">수정</button>
        </div>
      </template>
    </ScheduleXCalendar>

    <div v-if="isMobile && isChief && selectedAgendaDate" class="mobile-add-btn-wrap">
      <button class="mobile-add-btn" @click="openAddForDate">+ 일정 추가</button>
    </div>

    <div v-if="showSubscribe" class="subscribe-overlay" @click.self="showSubscribe = false">
      <div class="subscribe-dialog">
        <div class="subscribe-dialog__header">
          <span class="subscribe-dialog__title">Google Calendar 연동</span>
          <button class="subscribe-dialog__close" @click="showSubscribe = false">&times;</button>
        </div>
        <div class="subscribe-dialog__url-row">
          <input class="subscribe-dialog__url" :value="subscribeUrl" readonly @focus="$event.target.select()" />
          <button class="subscribe-dialog__copy" @click="copySubscribeUrl">{{ copied ? "복사됨" : "복사" }}</button>
        </div>
        <ol class="subscribe-dialog__steps">
          <li>PC에서 <a href="https://calendar.google.com/calendar/r/settings/addbyurl" target="_blank" rel="noopener">Google Calendar 설정</a> 접속</li>
          <li>위 URL을 붙여넣고 '캘린더 추가' 클릭</li>
        </ol>
      </div>
    </div>

    <EventModal
      v-if="showEventModal"
      :event="editingEvent"
      @save="handleSave"
      @delete="handleDelete"
      @close="showEventModal = false"
    />
  </div>
</template>

<style scoped>
.calendar-container {
  padding-top: 0.5rem;
}

/* ── schedule-x theme mapping ── */
.calendar-container :deep(.sx__calendar) {
  --sx-color-primary: var(--accent-primary, #5e6ad2);
  --sx-color-on-primary: #fff;
  --sx-color-surface: var(--bg-card, #fff);
  --sx-color-on-surface: var(--text-primary, #0f172a);
  --sx-color-surface-container: var(--bg-secondary, #f8fafc);
  --sx-color-surface-container-high: var(--bg-hover, #f1f5f9);
  --sx-color-on-surface-variant: var(--text-secondary, #475569);
  --sx-color-outline: var(--border-color, #e2e8f0);
  --sx-color-outline-variant: var(--border-color, #e2e8f0);
  font-family: "Noto Sans KR", sans-serif;
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

[data-theme="dark"] .calendar-container :deep(.sx__calendar) {
  --sx-color-primary: var(--accent-primary, #60a5fa);
  --sx-color-on-primary: #fff;
  --sx-color-surface: #1e2027;
  --sx-color-surface-dim: #16171c;
  --sx-color-surface-bright: #2a2c34;
  --sx-color-on-surface: #e2e4e9;
  --sx-color-surface-container: #16171c;
  --sx-color-surface-container-low: #16171c;
  --sx-color-surface-container-high: #2a2c34;
  --sx-color-background: #16171c;
  --sx-color-on-background: #e2e4e9;
  --sx-color-on-surface-variant: #b0b4be;
  --sx-color-outline: rgba(255, 255, 255, 0.08);
  --sx-color-outline-variant: rgba(255, 255, 255, 0.08);
  --sx-internal-color-gray-ripple-background: #2a2c34;
  --sx-internal-color-light-gray: #1e2027;
  --sx-internal-color-text: #e2e4e9;
}

/* ── Override theme rules that hide nav/heading ── */
.calendar-container :deep(.sx__forward-backward-navigation) {
  display: flex !important;
}

/* Hide built-in heading, use Vue-controlled custom heading */
.calendar-container :deep(.sx__range-heading) {
  display: none !important;
}

.custom-range-heading {
  font-weight: 600;
  font-size: 1.125rem;
  color: var(--text-primary, #0f172a);
  white-space: nowrap;
}

/* Center the header content */
.calendar-container :deep(.sx__calendar-header-content) {
  justify-content: center;
  align-items: center;
}

/* ── Header styling ── */
.calendar-container :deep(.sx__calendar-header) {
  background: var(--bg-card, #fff);
  border-bottom: 1px solid var(--border-color, #e2e8f0);
  padding: 0.625rem 1rem;
}

[data-theme="dark"] .calendar-container :deep(.sx__calendar-header) {
  background: var(--bg-card, #1e293b);
}

/* Hide today button */
.calendar-container :deep(.sx__today-button) {
  display: none !important;
}

/* Hide date picker entirely */
.calendar-container :deep(.sx__date-picker-wrapper) {
  display: none !important;
}

/* Nav buttons styling */
.calendar-container :deep(.sx__forward-backward-navigation) {
  gap: 0.25rem;
}

.calendar-container :deep(.sx__chevron-wrapper) {
  border-radius: 8px;
  transition: background 0.2s;
}

.calendar-container :deep(.sx__chevron-wrapper:hover) {
  background: var(--bg-hover, #f1f5f9);
}

/* Hide view selection — auto-switches between monthGrid/monthAgenda by screen size */
.calendar-container :deep(.sx__view-selection) {
  display: none !important;
}

.calendar-container :deep(.sx__view-selection-selected-item) {
  border-radius: 8px;
  border: 1px solid var(--border-color, #e2e8f0);
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary, #0f172a);
  background: var(--bg-card, #fff);
  transition: border-color 0.2s;
}

.calendar-container :deep(.sx__view-selection-selected-item:hover) {
  border-color: var(--accent-primary, #5e6ad2);
}

.calendar-container :deep(.sx__view-selection-items) {
  border-radius: 8px;
  border: 1px solid var(--border-color, #e2e8f0);
  box-shadow: var(--shadow-hover);
  overflow: hidden;
  background: var(--bg-card, #fff);
}

.calendar-container :deep(.sx__view-selection-item) {
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  color: var(--text-primary, #0f172a);
}

.calendar-container :deep(.sx__view-selection-item:hover),
.calendar-container :deep(.sx__view-selection-item.is-selected) {
  background: var(--bg-hover, #f1f5f9);
}

/* ── Desktop: larger fonts and cell height ── */
@media (min-width: 769px) {
  .calendar-container :deep(.sx__month-grid-day) {
    min-height: 120px;
  }

  .calendar-container :deep(.sx__calendar) {
    font-size: 0.9375rem;
  }

  .calendar-container :deep(.sx__month-grid-day__header-date) {
    font-size: 0.9375rem;
  }

  .calendar-container :deep(.sx__month-grid-day__header-day-name) {
    font-size: 0.9375rem;
  }

  .calendar-container :deep(.sx__month-grid-event) {
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .custom-range-heading {
    font-size: 1.25rem;
  }
}

/* ── Event popup styling ── */
.calendar-container :deep(.sx__event-modal) {
  border-radius: 12px;
  border: 1px solid var(--border-color, #e2e8f0);
  box-shadow: var(--shadow-hover);
  background: var(--bg-card, #fff);
  padding: 0;
  overflow: hidden;
}

[data-theme="dark"] .calendar-container :deep(.sx__event-modal) {
  background: var(--bg-card, #1e293b);
  border-color: var(--border-color, #334155);
}

.event-popup {
  padding: 0.875rem 1rem;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 2rem));
}

/* Mobile: fixed-center the popup to avoid overflow and repositioning flash */
@media (max-width: 768px) {
  .calendar-container :deep(.sx__event-modal) {
    position: fixed !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    max-width: calc(100vw - 2rem);
  }
}

.event-popup__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.625rem;
}

.event-popup__header .event-popup__role {
  flex-shrink: 0;
}

.event-popup__title {
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--text-primary, #0f172a);
  line-height: 1.3;
}

.event-popup__row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--text-secondary, #475569);
  margin-bottom: 0.375rem;
  line-height: 1.4;
}

.event-popup__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--text-tertiary, #94a3b8);
}

.event-popup__desc span {
  white-space: pre-wrap;
}

.event-popup__role {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 500;
}

.role-public { background: rgba(100, 116, 139, 0.25); color: var(--text-secondary, #334155); }
.role-student { background: rgba(16, 185, 129, 0.15); color: #059669; }
.role-staff { background: rgba(13, 148, 136, 0.15); color: #0d9488; }
.role-official { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
.role-chief { background: rgba(245, 158, 11, 0.15); color: #d97706; }
.role-master { background: rgba(124, 58, 237, 0.15); color: #7c3aed; }
.role-admin { background: rgba(239, 68, 68, 0.15); color: #dc2626; }

.event-popup__edit-btn {
  display: inline-block;
  margin-top: 0.625rem;
  padding: 0.375rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  background: var(--bg-secondary, #f8fafc);
  color: var(--text-primary, #0f172a);
  cursor: pointer;
  transition: all 0.2s;
}

.event-popup__edit-btn:hover {
  border-color: var(--accent-primary, #5e6ad2);
  color: var(--accent-primary, #5e6ad2);
}

/* ── Month agenda event items (match default schedule-x style + extras) ── */
.agenda-event-inner {
  padding: var(--sx-spacing-padding2, 8px);
  border-radius: var(--sx-rounding-extra-small, 4px);
  font-size: var(--sx-font-small, 0.875rem);
}

.agenda-event__row {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  font-size: 0.75rem;
  opacity: 0.85;
  margin-top: 0.25rem;
  line-height: 1.3;
}

.agenda-event__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

.agenda-event__desc span {
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Mobile add button ── */
.mobile-add-btn-wrap {
  padding: 0.5rem 0.5rem 0;
}

.mobile-add-btn {
  width: 100%;
  padding: 0.625rem;
  border: 1px dashed var(--border-color, #e2e8f0);
  border-radius: 8px;
  background: transparent;
  color: var(--accent-primary, #5e6ad2);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.mobile-add-btn:hover {
  background: var(--bg-hover, #f1f5f9);
}

/* ── Dim non-current-month dates ── */
.calendar-container :deep(.sx__month-grid-day.is-leading-or-trailing) {
  opacity: 0.35 !important;
}

.calendar-container :deep(.sx__month-agenda-day.is-leading-or-trailing) {
  opacity: 0.35 !important;
}

/* ── Hide "no events" text in month agenda ── */
.calendar-container :deep(.sx__month-agenda-events__empty) {
  display: none !important;
}

/* ── List view styling ── */
.calendar-container :deep(.sx__list) {
  border-top: none;
}

/* ── Subscribe button ── */
.calendar-container :deep(.sx__calendar-header) {
  position: relative;
}

.subscribe-btn {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #475569);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}

.subscribe-btn:hover {
  background: var(--bg-hover, #f1f5f9);
  color: var(--accent-primary, #5e6ad2);
}

.subscribe-btn svg {
  width: 18px;
  height: 18px;
}

/* ── Subscribe dialog ── */
.subscribe-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
}

.subscribe-dialog {
  background: var(--bg-card, #fff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 12px;
  box-shadow: var(--shadow-hover);
  padding: 1.25rem;
  width: min(420px, calc(100vw - 2rem));
}

[data-theme="dark"] .subscribe-dialog {
  background: var(--bg-card, #1e293b);
  border-color: var(--border-color, #334155);
}

.subscribe-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.subscribe-dialog__title {
  font-weight: 600;
  font-size: 1rem;
  color: var(--text-primary, #0f172a);
}

.subscribe-dialog__close {
  border: none;
  background: none;
  font-size: 1.25rem;
  color: var(--text-tertiary, #94a3b8);
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}

.subscribe-dialog__desc {
  font-size: 0.8125rem;
  color: var(--text-secondary, #475569);
  margin: 0 0 0.75rem;
  line-height: 1.5;
}

.subscribe-dialog__url-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.subscribe-dialog__url {
  flex: 1;
  padding: 0.5rem 0.625rem;
  font-size: 0.75rem;
  font-family: monospace;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  background: var(--bg-secondary, #f8fafc);
  color: var(--text-primary, #0f172a);
  outline: none;
  min-width: 0;
}

[data-theme="dark"] .subscribe-dialog__url {
  background: var(--bg-secondary, #0f172a);
}

.subscribe-dialog__copy {
  flex-shrink: 0;
  padding: 0.5rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  background: var(--bg-secondary, #f8fafc);
  color: var(--text-primary, #0f172a);
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.subscribe-dialog__copy:hover {
  border-color: var(--accent-primary, #5e6ad2);
  color: var(--accent-primary, #5e6ad2);
}

.subscribe-dialog__steps {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.8125rem;
  color: var(--text-secondary, #475569);
  line-height: 1.8;
}

.subscribe-dialog__steps a {
  color: var(--accent-primary, #5e6ad2);
  text-decoration: none;
}

.subscribe-dialog__steps a:hover {
  text-decoration: underline;
}
</style>
