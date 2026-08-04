export const CALCULATION_MODES = ["computed", "suggestion"];
export const CALCULATION_OPERATIONS = ["multiply", "sum", "product", "range_lookup"];

const FIELD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function finiteNumber(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}은(는) 유효한 숫자여야 합니다.`);
  return number;
}

export function normalizeFieldKey(value) {
  const key = String(value || "").trim();
  if (!FIELD_KEY_PATTERN.test(key)) throw new Error("올바르지 않은 문항 키입니다.");
  return key;
}

export function normalizeCalculationConfig(value) {
  if (value === null || value === undefined || value === "") return null;
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("계산 설정 JSON이 올바르지 않습니다.");
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("계산 설정이 올바르지 않습니다.");
  }

  const mode = String(input.mode || "");
  const operation = String(input.operation || "");
  if (!CALCULATION_MODES.includes(mode)) throw new Error("올바르지 않은 계산 표시 방식입니다.");
  if (!CALCULATION_OPERATIONS.includes(operation)) throw new Error("지원하지 않는 계산 방식입니다.");

  if (!Array.isArray(input.sources)) throw new Error("계산 원본 문항을 선택해야 합니다.");
  const sources = [...new Set(input.sources.map(normalizeFieldKey))];
  const exactOneSource = operation === "multiply" || operation === "range_lookup";
  if (!sources.length || (exactOneSource && sources.length !== 1)) {
    throw new Error(exactOneSource ? "이 계산 방식은 원본 문항 하나가 필요합니다." : "원본 문항을 하나 이상 선택해야 합니다.");
  }

  const precision = input.precision === undefined ? 2 : Number(input.precision);
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new Error("표시 소수 자릿수는 0~6 사이의 정수여야 합니다.");
  }

  const normalized = { mode, operation, sources, precision };
  if (operation === "multiply") {
    normalized.factor = finiteNumber(input.factor, "곱할 값");
  }
  if (operation === "range_lookup") {
    if (!Array.isArray(input.ranges) || !input.ranges.length) {
      throw new Error("구간을 하나 이상 설정해야 합니다.");
    }
    normalized.ranges = input.ranges.map((range) => {
      if (!range || typeof range !== "object") throw new Error("구간 설정이 올바르지 않습니다.");
      return {
        max: finiteNumber(range.max, "구간 상한"),
        value: finiteNumber(range.value, "구간 결과"),
      };
    }).sort((a, b) => a.max - b.max);
    for (let i = 1; i < normalized.ranges.length; i++) {
      if (normalized.ranges[i - 1].max === normalized.ranges[i].max) {
        throw new Error("같은 구간 상한을 두 번 사용할 수 없습니다.");
      }
    }
  }
  return normalized;
}

// DB의 손상된 설정 때문에 검사지 전체가 열리지 않게 하지 않는다. 쓰기 API에서는
// normalizeCalculationConfig를 직접 호출해 잘못된 설정을 400으로 거부한다.
export function parseCalculationConfig(value) {
  try {
    return normalizeCalculationConfig(value);
  } catch {
    return null;
  }
}

export function serializeCalculationConfig(value) {
  const normalized = normalizeCalculationConfig(value);
  return normalized ? JSON.stringify(normalized) : "";
}

export function validateCalculationGraph(items) {
  const byKey = new Map();
  for (const item of items) {
    if (!item.field_key) continue;
    const key = normalizeFieldKey(item.field_key);
    if (byKey.has(key)) throw new Error(`문항 키가 중복되었습니다: ${key}`);
    byKey.set(key, item);
  }

  for (const item of items) {
    const config = normalizeCalculationConfig(item.calculation);
    if (!config) continue;
    if (item.answer_type !== "number") throw new Error("숫자 문항에만 계산을 설정할 수 있습니다.");
    if (!item.field_key) throw new Error("계산 문항에 내부 문항 키가 없습니다.");
    for (const source of config.sources) {
      const sourceItem = byKey.get(source);
      if (!sourceItem) throw new Error(`원본 문항을 찾을 수 없습니다: ${source}`);
      if (!["number", "counter"].includes(sourceItem.answer_type)) {
        throw new Error("숫자 또는 증감 숫자 문항만 계산 원본으로 사용할 수 있습니다.");
      }
      if (source === item.field_key) throw new Error("문항이 자기 자신을 참조할 수 없습니다.");
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(key) {
    if (visiting.has(key)) throw new Error("계산 문항 사이에 순환 참조가 있습니다.");
    if (visited.has(key)) return;
    const item = byKey.get(key);
    const config = item ? normalizeCalculationConfig(item.calculation) : null;
    if (!config) return;
    visiting.add(key);
    for (const source of config.sources) visit(source);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of byKey.keys()) visit(key);
  return true;
}

function numericAnswer(value) {
  if (value === null || value === undefined || String(value).trim() === "") return { status: "missing" };
  const number = Number(value);
  return Number.isFinite(number) ? { status: "ok", value: number } : { status: "invalid" };
}

export function createCalculationEvaluator(items, answers = {}) {
  const byKey = new Map(items.filter(item => item.field_key).map(item => [item.field_key, item]));
  const cache = new Map();

  function rawAnswer(item) {
    if (typeof answers === "function") return answers(item.id, item);
    const answer = answers?.[item.id];
    return answer && typeof answer === "object" && "value" in answer ? answer.value : answer;
  }

  function evaluateKey(key, stack = new Set()) {
    if (cache.has(key)) return cache.get(key);
    const item = byKey.get(key);
    if (!item) return { status: "missing_source", source: key };
    const config = parseCalculationConfig(item.calculation);
    if (!config || config.mode === "suggestion") return numericAnswer(rawAnswer(item));
    if (stack.has(key)) return { status: "cycle", source: key };

    const nextStack = new Set(stack).add(key);
    const sourceResults = config.sources.map(source => evaluateKey(source, nextStack));
    const failed = sourceResults.find(result => result.status !== "ok");
    if (failed) {
      const result = { ...failed, source: failed.source || config.sources[sourceResults.indexOf(failed)] };
      cache.set(key, result);
      return result;
    }
    const values = sourceResults.map(result => result.value);
    let value;
    if (config.operation === "multiply") value = values[0] * config.factor;
    else if (config.operation === "sum") value = values.reduce((sum, number) => sum + number, 0);
    else if (config.operation === "product") value = values.reduce((product, number) => product * number, 1);
    else if (config.operation === "range_lookup") {
      const range = config.ranges.find(candidate => values[0] <= candidate.max);
      if (!range) {
        const result = { status: "out_of_range", source: config.sources[0] };
        cache.set(key, result);
        return result;
      }
      value = range.value;
    }
    if (!Number.isFinite(value)) {
      const result = { status: "invalid" };
      cache.set(key, result);
      return result;
    }
    const result = { status: "ok", value, precision: config.precision };
    cache.set(key, result);
    return result;
  }

  function evaluate(itemOrKey) {
    const item = typeof itemOrKey === "string" ? byKey.get(itemOrKey) : itemOrKey;
    if (!item) return { status: "missing_source" };
    const config = parseCalculationConfig(item.calculation);
    if (!config) return numericAnswer(rawAnswer(item));
    if (config.mode === "suggestion") {
      const virtual = { ...item, calculation: { ...config, mode: "computed" } };
      const previous = byKey.get(item.field_key);
      byKey.set(item.field_key, virtual);
      cache.delete(item.field_key);
      const result = evaluateKey(item.field_key);
      byKey.set(item.field_key, previous);
      cache.delete(item.field_key);
      return result;
    }
    return evaluateKey(item.field_key);
  }

  return { evaluate, evaluateKey };
}

export function formatCalculationValue(result, locale = "ko-KR") {
  if (!result || result.status !== "ok") return "";
  return result.value.toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: result.precision ?? 2,
  });
}
