import { getChecktableConfig, getInspectionItemState } from "../../../inspection/lib/item-status.mjs";
import { BASE_URL, getAuthCookie } from "./auth.mjs";

function responseItems(category) {
  return (category.subcategories || []).flatMap((subcategory) =>
    (subcategory.groups || []).flatMap((group) => group.items || []),
  );
}

function completionValue(item) {
  if (item.answer_type === "passfail") return "N/A";
  if (item.answer_type === "checktable") {
    const { rows, columns } = getChecktableConfig(item);
    if (!rows.length || !columns.length) {
      throw new Error(`Check table ${item.id} has no valid completion cell`);
    }
    return JSON.stringify({ "0_0": "1" });
  }
  return "1";
}

async function replaceAnswer({ year, teamNum, itemId, value, expectedValue, headers }) {
  const response = await fetch(`${BASE_URL}/competition/api/v1/inspection/sheet/answer`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      year,
      team_num: teamNum,
      item_id: itemId,
      value,
      expectedValue,
    }),
  });
  if (response.status !== 200) {
    throw new Error(`Could not update inspection answer ${itemId}: ${response.status}`);
  }
}

export async function completeInspectionCategory({ year, teamNum, category, role = "admin" }) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie(role),
  };
  const dataResponse = await fetch(
    `${BASE_URL}/competition/api/v1/inspection/sheet/data/${year}/${teamNum}`,
    { headers },
  );
  if (dataResponse.status !== 200) throw new Error(`Could not read inspection sheet: ${dataResponse.status}`);
  const data = await dataResponse.json();
  const changes = [];

  for (const item of responseItems(category)) {
    const current = data.answers[item.id]?.value || "";
    if (getInspectionItemState(item, current) !== "unanswered") continue;
    const value = completionValue(item);
    await replaceAnswer({ year, teamNum, itemId: item.id, value, expectedValue: current, headers });
    changes.push({ itemId: item.id, value: current });
  }
  return changes;
}

export async function restoreInspectionAnswers({ year, teamNum, changes, role = "admin" }) {
  if (!changes?.length) return;
  const headers = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie(role),
  };
  const dataResponse = await fetch(
    `${BASE_URL}/competition/api/v1/inspection/sheet/data/${year}/${teamNum}`,
    { headers },
  );
  if (dataResponse.status !== 200) throw new Error(`Could not read inspection sheet: ${dataResponse.status}`);
  const data = await dataResponse.json();

  for (const change of changes) {
    await replaceAnswer({
      year,
      teamNum,
      itemId: change.itemId,
      value: change.value,
      expectedValue: data.answers[change.itemId]?.value || "",
      headers,
    });
  }
}
