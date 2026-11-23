const base = import.meta.env.PROD ? "/course" : "";

export async function requestPublicCourse(path, { signal } = {}) {
  const response = await fetch(`${base}${path}`, { signal, credentials: "omit", cache: "no-store" });
  if (!response.ok) {
    const error = new Error(await response.text() || "공개 코스를 불러오지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return response.json();
}
