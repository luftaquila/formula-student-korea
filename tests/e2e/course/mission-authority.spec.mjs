import { test, expect } from "@playwright/test";
import {
  expectNotification,
  storageStatePath,
  waitForPageReady,
} from "../helpers/utils.mjs";

test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 1280, height: 800 },
});

async function emitMissionAuthority(page, mission) {
  await page.evaluate((payload) => {
    const source = window.__courseEventSources?.find((candidate) => (
      candidate.url.endsWith("/course/api/events")
    ));
    if (!source) throw new Error("Course EventSource is not connected");
    source.dispatchEvent(new MessageEvent("rover:mission", {
      data: JSON.stringify({ mission: payload }),
    }));
  }, mission);
}

test.describe("Mission authority UI integration", () => {
  let courseId;
  let mission;

  test.beforeEach(async ({ page }) => {
    const name = `e2e-mission-authority-${Date.now()}-${test.info().parallelIndex}`;
    const courseResponse = await page.request.post("/course/api/courses", { data: { name } });
    expect(courseResponse.ok()).toBeTruthy();
    courseId = (await courseResponse.json()).id;

    const coneResponse = await page.request.post(`/course/api/courses/${courseId}/cones`, {
      data: { lat: 37.50001, lng: 127.00001, side: "left" },
    });
    expect(coneResponse.ok()).toBeTruthy();
    const cone = await coneResponse.json();
    const missionId = 900000 + courseId;
    mission = {
      id: missionId,
      course_id: courseId,
      course_name: name,
      status: "interrupted",
      hold_reason: "operator_stop",
      motion_confirmed_held: true,
      finish_behavior: "stop",
      plan_hash: "plan-at-load",
      occurrence_revision: "occurrences-at-load",
      protocol_version: 2,
      active_command_id: null,
      active_hold_id: null,
      empty_plan_mode: null,
      start_position: { lat: 37.5, lng: 127.0, alt: null },
      waypoints: [{
        id: missionId * 10,
        cone_id: cone.id,
        lat: cone.lat,
        lng: cone.lng,
        alt: cone.alt,
        side: cone.side,
        state: "pending",
        outcome: null,
      }],
    };

    await page.addInitScript(({ id }) => {
      localStorage.setItem("mapview.activeCourseId", String(id));
      window.__courseEventSources = [];
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super();
          this.url = String(url);
          this.readyState = 1;
          window.__courseEventSources.push(this);
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }

        close() {
          this.readyState = 2;
        }
      };
    }, { id: courseId });

    await page.route("**/course/api/rover/status", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        nav_state: "PAUSED",
        stop_requested: false,
        fix_status: "rtk_fixed",
        ntrip_connected: true,
        last_position: { lat: 37.5, lng: 127.0 },
        battery: { percent: 90 },
        mission_protocol: {
          required: 2,
          connected: 2,
          compatible: true,
          boot_id: "e2e-mission-authority",
        },
        active_mission: mission,
      }),
    }));

    await page.goto("/course");
    await waitForPageReady(page);
    await page.locator(".rail-btn[title='로버']").click();
    await expect(page.getByRole("button", { name: "이어서 실행", exact: true })).toBeVisible();
    await expect(page.locator(".path-info")).toContainText("웨이포인트 0/1");
  });

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("keeps an accepted End visible until terminal mission authority arrives", async ({ page }) => {
    const commandId = `end-${mission.id}`;
    const acceptedMission = { ...mission, active_command_id: commandId };
    await page.route(`**/course/api/missions/${mission.id}/end`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        delivered: true,
        command_id: commandId,
        mission: acceptedMission,
      }),
    }));

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "미션 종료", exact: true }).click();

    await expect(page.getByRole("button", { name: "정지 확인 대기…", exact: true })).toBeDisabled();
    await expect(page.locator(".path-info")).toContainText("웨이포인트 0/1");

    await emitMissionAuthority(page, {
      ...acceptedMission,
      status: "cancelled",
      active_command_id: null,
    });

    await expect(page.getByRole("button", { name: "정지 확인 대기…", exact: true })).toHaveCount(0);
    await expect(page.locator(".path-info")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "경로 계산", exact: true })).toBeVisible();
  });

  test("invalidates an open preflight when newer mission authority arrives", async ({ page }) => {
    let missionMutationRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes(`/course/api/missions/${mission.id}/`)) {
        missionMutationRequests += 1;
      }
    });

    await page.getByRole("button", { name: "이어서 실행", exact: true }).click();
    const preflight = page.locator(".preflight-modal");
    await expect(preflight).toContainText("재개 전 점검");
    await expect(preflight.getByRole("button", { name: "이어서 실행", exact: true })).toBeEnabled();

    await emitMissionAuthority(page, { ...mission, plan_hash: "newer-plan" });
    await preflight.getByRole("button", { name: "이어서 실행", exact: true }).click();

    await expectNotification(page, "error", "점검 중 미션 상태가 변경되었습니다");
    await expect(preflight).toHaveCount(0);
    expect(missionMutationRequests).toBe(0);
  });

  test("does not resume from a stale remaining-route response", async ({ page }) => {
    let resolveRemainingRequest;
    const remainingRequested = new Promise((resolve) => { resolveRemainingRequest = resolve; });
    let releaseRemainingResponse;
    const remainingResponseReleased = new Promise((resolve) => { releaseRemainingResponse = resolve; });
    let resumeRequests = 0;

    await page.route(`**/course/api/missions/${mission.id}/remaining`, async (route) => {
      resolveRemainingRequest();
      await remainingResponseReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mission),
      });
    });
    page.on("request", (request) => {
      if (request.url().endsWith(`/course/api/missions/${mission.id}/resume`)) resumeRequests += 1;
    });

    await page.getByRole("button", { name: "이어서 실행", exact: true }).click();
    const preflight = page.locator(".preflight-modal");
    await expect(preflight.getByRole("button", { name: "이어서 실행", exact: true })).toBeEnabled();
    await preflight.getByRole("button", { name: "이어서 실행", exact: true }).click();
    await remainingRequested;

    await emitMissionAuthority(page, { ...mission, occurrence_revision: "newer-occurrences" });
    releaseRemainingResponse();

    await expectNotification(page, "error", "요청 중 미션 상태가 변경되었습니다");
    expect(resumeRequests).toBe(0);
    await expect(page.getByRole("button", { name: "이어서 실행", exact: true })).toBeVisible();
  });
});
