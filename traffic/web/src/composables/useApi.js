const BASE_URL = import.meta.env.PROD ? '/traffic' : ''

/**
 * 공통 fetch 래퍼
 * @param {string} endpoint - API 엔드포인트
 * @param {RequestInit} options - fetch 옵션
 * @returns {Promise<Response>}
 */
async function request(endpoint, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, config)

  if (!res.ok) {
    const message = await res.text()
    throw new Error(message || `요청 실패 (${res.status})`)
  }

  return res
}

/* ============================================
   Entry API
   ============================================ */

/**
 * 모든 엔트리 목록 조회
 */
export async function fetchEntries() {
  const res = await request('/api/entries')
  return res.json()
}

/**
 * 특정 엔트리 조회
 */
export async function fetchEntry(num) {
  const res = await request(`/api/entries/${num}`)
  return res.json()
}

/**
 * 엔트리 추가
 */
export async function addEntry({ num, univ, team }) {
  await request('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ num, univ, team }),
  })
}

/**
 * 엔트리 삭제
 */
export async function deleteEntry(num) {
  await request(`/api/entries/${num}`, {
    method: 'DELETE',
  })
}

/* ============================================
   Record API
   ============================================ */

/**
 * 모든 기록 테이블 목록 조회
 */
export async function fetchRecords() {
  const res = await request('/api/records')
  return res.json()
}

/**
 * 특정 기록 조회
 */
export async function fetchRecord(name) {
  const res = await request(`/api/records/${encodeURIComponent(name)}`)
  return res.json()
}

/**
 * 새 기록 추가
 */
export async function addRecord(name, data) {
  await request('/api/records', {
    method: 'POST',
    body: JSON.stringify({ name, data }),
  })
}

/**
 * 기록 테이블 삭제
 */
export async function deleteRecord(name) {
  await request(`/api/records/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

/* ============================================
   Controller API
   ============================================ */

/**
 * 모든 컨트롤러 로그 조회
 */
export async function fetchControllers() {
  const res = await request('/api/controllers')
  return res.json()
}

/**
 * 컨트롤러 로그 추가
 */
export async function addControllerLog(timestamp, data) {
  await request('/api/controllers', {
    method: 'POST',
    body: JSON.stringify({ timestamp, data }),
  })
}

/**
 * 모든 컨트롤러 로그 삭제
 */
export async function deleteControllers() {
  await request('/api/controllers', {
    method: 'DELETE',
  })
}
