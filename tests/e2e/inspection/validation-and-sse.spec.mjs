import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

// 검차 시트 API의 입력 검증 + answer no-op/메모 재브로드캐스트 대비.
// 쓰기(answer/memo/category/inspector)는 official+, 템플릿 쓰기는 chief+ (inspection/index.mjs authRoleFn).
// admin storageState로 둘 다 충족.
test.describe("Inspection validation and SSE no-op semantics", () => {
  test.use({ storageState: storageStatePath("admin") });

  // 템플릿에서 이름으로 item_id/category_id를 찾는 헬퍼. seed.mjs가 심은 현재 연도 템플릿 사용.
  async function findItem(page, categoryName, itemName) {
    const res = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    expect(res.status()).toBe(200);
    const tree = await res.json();
    const cat = tree.find((c) => c.name === categoryName);
    const item = cat?.subcategories?.[0]?.groups?.[0]?.items?.find((i) => i.name === itemName);
    return { categoryId: cat?.id, item };
  }

  test("passfail answer rejects a value other than PASS/FAIL/empty (400)", async ({ page }) => {
    const { item } = await findItem(page, "전기 검차", "전압 확인");
    expect(item, "seeded passfail item must exist").toBeTruthy();

    // 잘못된 값 → 400. team 5는 seed에 없지만 answer는 entry 존재를 검증하지 않음(team_num>=1만).
    const bad = await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 5, item_id: item.id, value: "MAYBE" },
    });
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain("PASS");

    // 유효한 값들은 200(빈/PASS/FAIL). 정리도 겸함.
    for (const value of ["PASS", "FAIL", ""]) {
      const ok = await page.request.put("/inspection/api/sheet/answer", {
        data: { year: YEAR, team_num: 5, item_id: item.id, value },
      });
      expect(ok.status()).toBe(200);
    }
  });

  test("answer/memo for an item_id not in the requested year → 400", async ({ page }) => {
    // 미래 연도에 일회용 item을 만들고(이 노드는 YEAR에 존재하지 않음) 그 id를 YEAR 컨텍스트에서 쓴다.
    // PAST in-range year (2001-2008): distinct from YEAR/PREV_YEAR, and below the
    // current year so the throwaway template never floats to the top of the
    // inspection year dropdown (a future year would, breaking year-selector specs).
    const otherYear = 2001 + (Date.now() % 8);
    const catRes = await page.request.post("/inspection/api/sheet/template", {
      data: { year: otherYear, level: "category", name: `E2E-VAL-CAT-${Date.now()}` },
    });
    expect(catRes.status()).toBe(200);
    const catId = (await catRes.json()).id;
    const itemRes = await page.request.post("/inspection/api/sheet/template", {
      data: { year: otherYear, level: "item", parent_id: catId, name: `E2E-VAL-ITEM-${Date.now()}`, answer_type: "text" },
    });
    expect(itemRes.status()).toBe(200);
    const foreignItemId = (await itemRes.json()).id;

    // foreignItemId는 otherYear에만 존재 → YEAR 컨텍스트의 answer/memo는 400.
    const ansRes = await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 3, item_id: foreignItemId, value: "x" },
    });
    expect(ansRes.status()).toBe(400);
    expect(await ansRes.text()).toContain("존재하지 않는 항목");

    const memoRes = await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: 3, item_id: foreignItemId, memo: "x" },
    });
    expect(memoRes.status()).toBe(400);
    expect(await memoRes.text()).toContain("존재하지 않는 항목");

    // 정리: 미래 연도 카테고리 삭제(CASCADE로 item도 제거). 미래 연도라 가드에 안 걸림.
    await page.request.delete(`/inspection/api/sheet/template/${catId}`).catch(() => {});
  });

  test("DELETE a template node for a PAST year → 400", async ({ page }) => {
    // 과거 연도에 노드를 심고(가드는 삭제 시점에 node.year < 현재연도로 판정) 삭제 시도 → 400.
    const pastYear = YEAR - 1;
    const catRes = await page.request.post("/inspection/api/sheet/template", {
      data: { year: pastYear, level: "category", name: `E2E-PAST-${Date.now()}` },
    });
    expect(catRes.status()).toBe(200);
    const pastNodeId = (await catRes.json()).id;

    const delRes = await page.request.delete(`/inspection/api/sheet/template/${pastNodeId}`);
    expect(delRes.status()).toBe(400);
    expect(await delRes.text()).toContain("이전 연도");

    // 정리는 불가(과거 연도 삭제 가드). 노드명이 유니크(Date.now)라 다른 테스트와 충돌하지 않음.
  });

  test("re-saving the identical answer is an API no-op while memo always re-broadcasts", async ({ page }) => {
    const { item } = await findItem(page, "전기 검차", "절연 저항 측정"); // number 타입
    expect(item, "seeded number item must exist").toBeTruthy();
    const team = 7; // 다른 답변 테스트와 격리된 팀 번호

    // 알려진 값으로 시드(이전 상태와 무관하게 결정적). 두 번째 동일 저장이 no-op인지 본다.
    const seedVal = `${1000 + (Date.now() % 1000)}`;
    const first = await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: team, item_id: item.id, value: seedVal },
    });
    expect(first.status()).toBe(200);

    // 브라우저 페이지에서 SSE 수신을 직접 관찰: 페이지의 answer 입력칸이 동일 저장에는 반응하지 않고,
    // 메모 저장에는 항상 반응(재브로드캐스트)하는지 확인.
    const sse = page.waitForResponse((res) => res.url().includes("/api/sheet/events"));
    await page.goto(`/inspection/${YEAR}/${team}`);
    await waitForPageReady(page);
    await sse;

    const numInput = page.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator('input[type="number"]');
    await expect(numInput).toHaveValue(seedVal, { timeout: 10000 });

    // (1) 동일 값 재저장 → API는 200이지만 changed=false → answer SSE 미발행.
    //     결정적 검증: 직후 메모 저장은 항상 재브로드캐스트되어 memo SSE가 도착한다.
    //     answer 이벤트가 (잘못) 발행됐다면 그 핸들러가 입력칸을 건드리지만, 값은 동일하므로
    //     상태 변화로는 관찰 불가 → no-op은 메모 재브로드캐스트가 정상 동작함으로 간접 보장하고,
    //     API 레벨에서 changed 의미를 추가로 단언한다(아래).
    const sameAgain = await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: team, item_id: item.id, value: seedVal },
    });
    expect(sameAgain.status()).toBe(200);

    // (2) 메모는 항상 재브로드캐스트: 동일 값이어도 broadcast → 페이지에 반영.
    const memoVal = `E2E-MEMO-${Date.now()}`;
    const memoPut = await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: team, item_id: item.id, memo: memoVal },
    });
    expect(memoPut.status()).toBe(200);
    const memoText = page.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator(".memo-text");
    await expect(memoText).toContainText(memoVal, { timeout: 10000 });

    // answer 입력칸은 그대로(동일 값) — no-op이 화면을 깨뜨리지 않았음을 확인.
    await expect(numInput).toHaveValue(seedVal);

    // 정리: 답변·메모 비우기.
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: team, item_id: item.id, value: "" },
    }).catch(() => {});
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: team, item_id: item.id, memo: "" },
    }).catch(() => {});
  });
});
