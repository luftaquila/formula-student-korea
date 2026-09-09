import crypto from "node:crypto";

export function createSubscriptionService() {
  // Generate HMAC signature for iCal subscription URL
  function generateICalSig(role) {
    return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`ical:${role}`).digest("hex");
  }

  function escapeICalText(text) {
    // 백슬래시 먼저 이스케이프한 뒤 특수문자를, 마지막으로 CR/LF를 이스케이프 개행(\n)으로
    // 정규화한다. \r를 그대로 두면 lone CR이 피드에 새어 라인이 조기 종결될 수 있다.
    return text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n?/g, "\\n")
      .replace(/\n/g, "\\n");
  }

  function formatICalDateTime(dateStr) {
    const d = /[zZ]$/.test(String(dateStr)) ? new Date(dateStr) : null;
    if (d && !Number.isNaN(d.getTime())) {
      d.setHours(d.getHours() + 9);
      const iso = d.toISOString();
      return iso.slice(0, 10).replace(/-/g, "") + "T" + iso.slice(11, 19).replace(/:/g, "");
    }
    return (
      dateStr.slice(0, 10).replace(/-/g, "") + "T" + dateStr.slice(11, 16).replace(/:/g, "") + "00"
    );
  }

  function generateICal(events) {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Formula Student Korea//Calendar//KO",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Formula Student Korea",
      "X-WR-TIMEZONE:Asia/Seoul",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Seoul",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "TZNAME:KST",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];

    const now = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");

    for (const event of events) {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:event-${event.id}@fsk-calendar`);
      lines.push(`DTSTAMP:${now}`);

      if (event.all_day) {
        lines.push(`DTSTART;VALUE=DATE:${event.start.slice(0, 10).replace(/-/g, "")}`);
        // iCal all-day DTEND is exclusive (day after the last day). Compute in UTC —
        // parsing "YYYY-MM-DDT00:00:00" as local time made the result shift by a day
        // when the server TZ isn't UTC. Date.UTC handles month/day rollover.
        const [ey, em, ed] = event.end.slice(0, 10).split("-").map(Number);
        const endExclusive = new Date(Date.UTC(ey, em - 1, ed + 1));
        lines.push(`DTEND;VALUE=DATE:${endExclusive.toISOString().slice(0, 10).replace(/-/g, "")}`);
      } else {
        lines.push(`DTSTART;TZID=Asia/Seoul:${formatICalDateTime(event.start)}`);
        lines.push(`DTEND;TZID=Asia/Seoul:${formatICalDateTime(event.end)}`);
      }

      lines.push(`SUMMARY:${escapeICalText(event.title)}`);
      if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
      if (event.location) lines.push(`LOCATION:${escapeICalText(event.location)}`);
      lines.push("TRANSP:TRANSPARENT");
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  return { generateICalSig, generateICal };
}
