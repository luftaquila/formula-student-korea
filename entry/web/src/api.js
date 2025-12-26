const BASE_URL = ''

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

/**
 * 모든 엔트리 목록 조회
 */
export async function fetchEntries() {
  const res = await request('/api/entries')
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
 * 엔트리 수정
 */
export async function updateEntry({ num, univ, team, prev }) {
  await request(`/api/entries/${prev}`, {
    method: 'PATCH',
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

/**
 * JSON 파일로 엔트리 일괄 업로드
 */
export async function uploadEntries(data) {
  await request('/api/entries/bulk', {
    method: 'POST',
    body: JSON.stringify({ data }),
  })
}

/**
 * 엔트리 JSON 다운로드 URL
 */
export function getDownloadUrl() {
  return '/api/entries?download'
}

