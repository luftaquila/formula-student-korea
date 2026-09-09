import { serviceUrl } from "../../../../../shared/server/services.mjs";
import { currentCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function createDocumentNotifications({ options, db, now, subtractHours, logger, toKST }) {
  const enableNotificationScheduler = options.enableNotificationScheduler !== false;

  const notificationTasks = new Set();

  /* ============================================
   Email Notification
   ============================================ */
  /* ============================================
   예약 알림 시스템
   ============================================ */

  /** 세션에 대한 예약 알림 등록 (미전송 건만 삭제 후 재등록) */
  function scheduleSessionNotifications(sessionId, start_at, end_at) {
    db.prepare("DELETE FROM scheduled_notification WHERE session_id = ? AND sent = 0").run(
      sessionId,
    );

    const currentTime = now();
    const insert = db.prepare(
      "INSERT INTO scheduled_notification (session_id, type, scheduled_at) VALUES (?, ?, ?)",
    );

    // 제출 시작 알림: 이미 발송된 경우 재등록하지 않음
    const alreadySent = db
      .prepare(
        "SELECT 1 FROM scheduled_notification WHERE session_id = ? AND type = 'session_open' AND sent = 1",
      )
      .get(sessionId);
    if (!alreadySent) {
      if (start_at > currentTime) {
        insert.run(sessionId, "session_open", start_at);
      } else {
        insert.run(sessionId, "session_open", currentTime);
      }
    }

    // 마감 3시간 전 알림
    const h3 = subtractHours(end_at, 3);
    if (h3 > currentTime) {
      insert.run(sessionId, "deadline_3h", h3);
    }

    // 마감 1시간 전 알림 (미제출 팀만)
    const h1 = subtractHours(end_at, 1);
    if (h1 > currentTime) {
      insert.run(sessionId, "deadline_1h", h1);
    }
  }

  /** 이메일 전송 공통 */
  async function sendNotificationEmail(subject, htmlContent, recipient) {
    if (options.sendNotificationEmail) {
      return options.sendNotificationEmail(subject, htmlContent, recipient);
    }
    const emailServer = serviceUrl("email");
    if (!process.env.INTERNAL_SECRET) return { ok: false, error: "INTERNAL_SECRET not configured" };

    // 이메일 발송은 Brevo 왕복이 포함돼 내부 표준(5초)보다 길게 잡는다
    const EMAIL_SEND_TIMEOUT_MS = 15000;
    const resp = await fetch(`${emailServer}/api/internal/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service": process.env.INTERNAL_SECRET,
      },
      body: JSON.stringify({ subject, htmlContent, recipients: [recipient], source: "documents" }),
      signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
    });

    if (!resp.ok) return { ok: false, error: await resp.text() };
    return { ok: true };
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** 엔트리 정보 조회. 공유 DB 읽기 실패는 감사한 뒤 호출자에게 전파한다. */
  async function fetchEntries(year, req = null, action = "entry.fetch") {
    if (!options.teamStore) {
      logger.warn(req, action, { error: "Competition team store is required", year });
      throw new Error("Competition team store is required");
    }
    try {
      return options.teamStore.moduleEntries(year, { includeInactive: true });
    } catch (error) {
      logger.warn(req, action, { error: error.message || String(error), year });
      throw error;
    }
  }

  /** 팀 정보 헤더 HTML */
  function teamHeaderHtml(teamNum, entries) {
    const entry = entries[teamNum];
    const label = entry
      ? `#${teamNum} ${escapeHtml(entry.univ)} ${escapeHtml(entry.team)}`
      : `#${teamNum}`;
    return `<p style="margin:0 0 12px;font-size:15px;font-weight:bold;font-style:italic;color:#333">${label}</p>`;
  }

  /** 예약 알림 처리 — 1분마다 실행 */
  let schedulerTask = null;

  let notificationDraining = false;

  function processScheduledNotifications() {
    // 재진입 가드: 발송(수신자별 순차 await, 건당 최대 15초)이 60초 인터벌을 넘기면 다음
    // tick이 겹쳐 실행돼 같은 sent=0 행을 다시 읽고 중복 발송한다. 한 번에 하나만 돈다.
    if (notificationDraining) return Promise.resolve();
    if (schedulerTask) return schedulerTask;
    schedulerTask = runScheduledNotifications();
    schedulerTask.then(
      () => {
        schedulerTask = null;
      },
      () => {
        schedulerTask = null;
      },
    );
    return schedulerTask;
  }

  async function runScheduledNotifications() {
    try {
      const currentTime = now();
      const pending = db
        .prepare(
          "SELECT sn.*, s.name, s.notice, s.start_at, s.end_at, s.late_end_at, s.year FROM scheduled_notification sn JOIN session s ON sn.session_id = s.id WHERE sn.sent = 0 AND sn.scheduled_at <= ? AND s.year = ?",
        )
        .all(currentTime, currentCompetitionYear());

      for (const n of pending) {
        try {
          const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
          const deadlineInfo = n.late_end_at
            ? `제출 마감: ${toKST(n.end_at)} (KST)<br>지각 마감: ${toKST(n.late_end_at)} (KST)`
            : `제출 마감: ${toKST(n.end_at)} (KST)`;

          // 수신자 결정 (team_num 포함)
          let recipientRows;
          if (n.type === "deadline_1h") {
            // 미제출 팀 학생만
            recipientRows = db
              .prepare(
                `SELECT st2.email, st.team_num FROM session_team st
           JOIN student_team st2 ON st.team_num = st2.team_num AND st2.year = ?
           WHERE st.session_id = ?
             AND st.team_num NOT IN (SELECT team_num FROM submission WHERE session_id = ?)`,
              )
              .all(n.year, n.session_id, n.session_id);
          } else {
            // 전체 대상 팀 학생
            recipientRows = db
              .prepare(
                `SELECT st2.email, st.team_num FROM session_team st
           JOIN student_team st2 ON st.team_num = st2.team_num AND st2.year = ?
           WHERE st.session_id = ?`,
              )
              .all(n.year, n.session_id);
          }

          if (recipientRows.length === 0) {
            const completion = db
              .prepare("UPDATE scheduled_notification SET sent = 1 WHERE id = ? AND sent = 0")
              .run(n.id);
            if (completion.changes !== 1) {
              throw new Error(
                `no-recipient completion updated ${completion.changes} scheduled notifications`,
              );
            }
            logger.log(
              null,
              `schedule.${n.type}`,
              {
                notificationId: n.id,
                sessionId: n.session_id,
                year: n.year,
                type: n.type,
                recipientCount: 0,
                completionReason: "no_recipients",
                before: { sent: Number(n.sent) },
                after: { sent: 1 },
              },
              n.name,
            );
            continue;
          }

          // 엔트리 정보 조회
          const entries = await fetchEntries(n.year);

          let subject;
          const safeName = escapeHtml(n.name);

          if (n.type === "session_open") subject = `[FSK] 서류 제출 안내: ${n.name}`;
          else if (n.type === "deadline_3h") subject = `[FSK] 서류 제출 마감 3시간 전: ${n.name}`;
          else if (n.type === "deadline_1h") subject = `[FSK] 서류 미제출 알림: ${n.name}`;

          // 수신자별 개별 발송 — 이미 성공한 수신자는 스킵(부분 실패 재시도 시 중복 방지).
          const alreadySent = new Set(JSON.parse(n.sent_recipients || "[]"));
          const todo = recipientRows.filter((r) => !alreadySent.has(r.email));
          const failed = []; // 이번 시도의 실패 내역 { email, error } (로그 폭주 방지를 위해 10건까지만 저장)
          for (const { email, team_num } of todo) {
            const teamHeader = teamHeaderHtml(team_num, entries);
            let htmlContent;

            if (n.type === "session_open") {
              const noticeHtml = n.notice ? escapeHtml(n.notice).replace(/\n/g, "<br>") : "";
              htmlContent =
                `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 안내</h2>` +
                teamHeader +
                (noticeHtml
                  ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${noticeHtml}</p>`
                  : "") +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">제출 시작: ${toKST(n.start_at)} (KST)</p>` +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
                `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`;
            } else if (n.type === "deadline_3h") {
              htmlContent =
                `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 마감 안내</h2>` +
                teamHeader +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${safeName} 서류 제출 마감이 3시간 남았습니다.</p>` +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
                `<p style="margin:0 0 8px;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>` +
                `<p style="margin:0;font-size:12px;color:#888">본 메일은 서류 제출 여부와 관계없이 발송되는 마감 안내 메일입니다.</p>`;
            } else if (n.type === "deadline_1h") {
              htmlContent =
                `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 미제출 알림</h2>` +
                teamHeader +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${safeName} 서류가 아직 제출되지 않았습니다. 마감까지 1시간 남았습니다.</p>` +
                `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
                `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`;
            }

            try {
              const result = await sendNotificationEmail(subject, htmlContent, email);
              if (result.ok) {
                alreadySent.add(email);
                // Persist each success immediately. A later recipient throwing or
                // the process stopping must not make an already-delivered address
                // eligible for the next scheduler retry.
                db.prepare(
                  "UPDATE scheduled_notification SET sent_recipients = ? WHERE id = ?",
                ).run(JSON.stringify([...alreadySent]), n.id);
              } else {
                const error = result.error || "email_send_rejected";
                if (failed.length < 10) failed.push({ email, error });
              }
            } catch (error) {
              if (failed.length < 10)
                failed.push({ email, error: error?.message || String(error) });
            }
          }

          // 현재 대상 중 아직 못 보낸 수신자가 남으면 sent=0을 유지해 다음 tick이 실패분만
          // 재시도한다(성공분은 sent_recipients로 스킵 → 중복 발송 없음). 진행 상황은 항상 저장.
          const remaining = recipientRows.filter((r) => !alreadySent.has(r.email));
          const sentList = JSON.stringify([...alreadySent]);
          if (remaining.length === 0) {
            db.prepare(
              "UPDATE scheduled_notification SET sent = 1, sent_recipients = ? WHERE id = ?",
            ).run(sentList, n.id);
            logger.log(null, `schedule.${n.type}`, { recipientCount: alreadySent.size }, n.name);
          } else {
            // 영구 실패(무효/바운스 주소)로 remaining이 계속 남으면 매 60s tick 무한 재시도 + warn
            // firehose가 된다. 재시도 상한(5회 ≈ 5분)을 두고, 초과하면 sent=1로 종료해 최종 실패만 남긴다.
            const attempts = (n.attempts || 0) + 1;
            const MAX_SEND_ATTEMPTS = 5;
            if (attempts >= MAX_SEND_ATTEMPTS) {
              db.prepare(
                "UPDATE scheduled_notification SET sent = 1, sent_recipients = ?, attempts = ? WHERE id = ?",
              ).run(sentList, attempts, n.id);
              logger.warn(
                null,
                `schedule.${n.type}`,
                {
                  error: "gave_up_after_max_attempts",
                  sent: alreadySent.size,
                  remaining: remaining.length,
                  attempts,
                  failed,
                },
                n.name,
              );
            } else {
              db.prepare(
                "UPDATE scheduled_notification SET sent_recipients = ?, attempts = ? WHERE id = ?",
              ).run(sentList, attempts, n.id);
              logger.warn(
                null,
                `schedule.${n.type}`,
                {
                  error: "partial_send",
                  sent: alreadySent.size,
                  remaining: remaining.length,
                  attempts,
                  failed,
                },
                n.name,
              );
            }
          }
        } catch (e) {
          logger.warn(
            null,
            `schedule.${n.type}`,
            {
              error: e.message || String(e),
              notificationId: n.id,
              sessionId: n.session_id,
              year: n.year,
              type: n.type,
              phase: "notification_processing",
            },
            n.name,
          );
        }
      }
    } catch (e) {
      // pending 쿼리 등 루프 밖에서 throw하면 setInterval 콜백의 미처리 프라미스 거부가 된다.
      // 구조화 로그로 남기고 스케줄러는 다음 tick에 계속 돈다.
      logger.warn(null, "schedule.run", { error: e.message || String(e) });
    }
  }

  // 1분마다 예약 알림 처리
  const _schedulerInterval = enableNotificationScheduler
    ? setInterval(processScheduledNotifications, 60_000)
    : null;

  // 서버 시작 후 5초 뒤 첫 실행 (밀린 알림 즉시 처리)
  const _schedulerStartupTimer = enableNotificationScheduler
    ? setTimeout(processScheduledNotifications, 5000)
    : null;

  /** 계정 할당 시 현재 열린 세션 알림 */
  function launchOpenSessionNotification(req, email, teamNum, year) {
    const task = notifyOpenSessions(req, email, teamNum, year);
    notificationTasks.add(task);
    void task.finally(() => notificationTasks.delete(task));
    return task;
  }

  async function drainNotificationTasks() {
    notificationDraining = true;
    if (_schedulerInterval) clearInterval(_schedulerInterval);
    if (_schedulerStartupTimer) clearTimeout(_schedulerStartupTimer);
    while (notificationTasks.size > 0 || schedulerTask) {
      await Promise.all([...notificationTasks, ...(schedulerTask ? [schedulerTask] : [])]);
    }
  }

  function hasPendingNotificationTasks() {
    return notificationTasks.size > 0 || schedulerTask != null;
  }

  async function notifyOpenSessions(req, email, teamNum, year) {
    try {
      const currentTime = now();
      const openSessions = db
        .prepare(
          `SELECT s.id, s.name, s.end_at, s.late_end_at FROM session s
       JOIN session_team st ON s.id = st.session_id
       WHERE st.team_num = ? AND s.year = ? AND s.start_at <= ? AND COALESCE(NULLIF(s.late_end_at, ''), s.end_at) > ?
         AND s.id NOT IN (SELECT session_id FROM submission WHERE team_num = ?)
       ORDER BY COALESCE(NULLIF(s.late_end_at, ''), s.end_at) ASC`,
        )
        .all(teamNum, year, currentTime, currentTime, teamNum);

      if (openSessions.length === 0) return;

      const entries = await fetchEntries(year);
      const teamHeader = teamHeaderHtml(teamNum, entries);

      const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
      const sessionList = openSessions
        .map((s) => {
          const safeName = escapeHtml(s.name);
          const deadlines = s.late_end_at
            ? `<li>제출 마감: ${toKST(s.end_at)} (KST)</li><li>지각 마감: ${toKST(s.late_end_at)} (KST)</li>`
            : `<li>제출 마감: ${toKST(s.end_at)} (KST)</li>`;
          return `<li><strong>${safeName}</strong><ul style="margin:4px 0 0;padding-left:20px">${deadlines}</ul></li>`;
        })
        .join("");

      const result = await sendNotificationEmail(
        `[FSK] 제출 대기 중인 서류가 있습니다`,
        `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 안내</h2>` +
          teamHeader +
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">현재 제출 대기 중인 서류 세션이 있습니다.</p>` +
          `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8">${sessionList}</ul>` +
          `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`,
        email,
      );

      if (!result.ok) {
        logger.warn(
          req,
          "student_team.notify",
          {
            error: result.error || "email_send_rejected",
            reason: result.error || "email_send_rejected",
            phase: "recipient_send",
            recipient: email,
            year,
            team_num: teamNum,
            session_count: openSessions.length,
          },
          email,
        );
      } else {
        logger.log(
          req,
          "student_team.notify",
          {
            recipient: email,
            year,
            team_num: teamNum,
            session_count: openSessions.length,
          },
          email,
        );
      }
    } catch (e) {
      logger.warn(
        req,
        "student_team.notify",
        {
          error: e.message,
          reason: e.message,
          recipient: email,
          year,
          team_num: teamNum,
        },
        email,
      );
    }
  }

  return {
    scheduleSessionNotifications,
    fetchEntries,
    processScheduledNotifications,
    _schedulerInterval,
    _schedulerStartupTimer,
    launchOpenSessionNotification,
    drainNotificationTasks,
    hasPendingNotificationTasks,
  };
}
