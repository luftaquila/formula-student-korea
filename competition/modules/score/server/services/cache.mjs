import { calculateAdjustedResult } from "../../lib/adjusted-result.mjs";

export function createScoreCache({ db, computeScore }) {
  const publishedYears = new Set(
    db
      .prepare("SELECT year FROM score_publication WHERE enabled = 1")
      .all()
      .map((row) => row.year),
  );

  function isScorePublished(year) {
    return publishedYears.has(Number(year));
  }

  // 공개 요청이 순차적으로 들어와도 매번 전체 업스트림 집계를 반복하지 않도록 짧게 캐시한다.
  // SSE 변경 이벤트가 도착하면 TTL과 관계없이 즉시 무효화되어 공개 화면의 실시간성은 유지된다.
  const PUBLIC_SCORE_CACHE_TTL_MS = 3000;

  const publicScoreCache = new Map();

  const publicScoreGenerations = new Map();

  let publicScoreGlobalGeneration = 0;

  function getPublicScoreGeneration(year) {
    return {
      global: publicScoreGlobalGeneration,
      year: publicScoreGenerations.get(year) || 0,
    };
  }

  function isPublicScoreGenerationCurrent(year, generation) {
    return (
      generation.global === publicScoreGlobalGeneration &&
      generation.year === (publicScoreGenerations.get(year) || 0)
    );
  }

  function invalidatePublicScoreCache(year = null) {
    if (year == null) {
      publicScoreCache.clear();
      publicScoreGlobalGeneration++;
    } else {
      const numYear = Number(year);
      publicScoreCache.delete(numYear);
      publicScoreGenerations.set(numYear, (publicScoreGenerations.get(numYear) || 0) + 1);
    }
  }

  /* ============================================
   API 라우트
   ============================================ */

  // year -> { promise, generation }. 같은 연도 동시 집계 요청을 하나로 합쳐 업스트림 호출 증폭을 막는다.
  const inflightScore = new Map();

  function invalidateInflightScore(year = null) {
    if (year == null) inflightScore.clear();
    else inflightScore.delete(Number(year));
  }

  function getComputedScoreRequest(year) {
    let request = inflightScore.get(year);
    if (!request) {
      request = {
        generation: getPublicScoreGeneration(year),
        promise: null,
      };
      request.promise = computeScore(year).finally(() => {
        if (inflightScore.get(year) === request) inflightScore.delete(year);
      });
      inflightScore.set(year, request);
    }
    return request;
  }

  function getComputedScore(year) {
    return getComputedScoreRequest(year).promise;
  }

  function createPublicScorePayload(year, score) {
    const entries = {};
    for (const [num, entry] of Object.entries(score.entries || {})) {
      entries[num] = {
        univ: entry.univ || "",
        team: entry.team || "",
        type: entry.type || "",
      };
    }

    const events = (score.events || [])
      .filter((event) => event.type !== "내구")
      .map((event) => {
        const penalty = score.penalties?.[event.type] || {};
        const records = {};
        for (const [num, record] of Object.entries(event.records || {})) {
          let result = record?.result ?? null;
          const status = record?.status ?? null;
          if (status == null && result != null) {
            result = calculateAdjustedResult(event.type, record, penalty);
          }
          records[num] = { result, status };
        }
        return { type: event.type, records };
      });

    return { year, entries, events };
  }

  async function getPublicScorePayload(year) {
    while (true) {
      const cached = publicScoreCache.get(year);
      if (cached && cached.expiresAt > Date.now()) return cached.payload;

      const request = getComputedScoreRequest(year);
      const score = await request.promise;
      if (!isScorePublished(year)) return null;
      // 집계 중 변경 이벤트가 발생했다면 무효화 이전 스냅샷을 반환하거나 캐시하지 않는다.
      if (!isPublicScoreGenerationCurrent(year, request.generation)) continue;

      const payload = createPublicScorePayload(year, score);
      publicScoreCache.set(year, {
        payload,
        expiresAt: Date.now() + PUBLIC_SCORE_CACHE_TTL_MS,
      });
      return payload;
    }
  }

  return {
    publishedYears,
    isScorePublished,
    invalidatePublicScoreCache,
    invalidateInflightScore,
    getComputedScore,
    getPublicScorePayload,
  };
}
