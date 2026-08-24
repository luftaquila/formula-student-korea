# Rover mission resume failure — 2026-08-09

## Scope and evidence

This review covered every server-side mission record from 2026-08-09 KST: mission IDs 33 through 47 (15 records), their stored waypoint arrays, progress/spray fields, telemetry, and course-service audit logs. The rover was offline when this analysis was performed, so ROS logs that had not already been uploaded were unavailable. Conclusions that require rover-local timing are therefore explicitly not inferred.

All 15 records shared the legacy data model:

- `course_id` was null, so a mission could not be tied back to cone identities in a course.
- The plan was a browser-produced array of latitude/longitude snapshots. There was no stable mission waypoint ID, cone ID, plan revision/hash, command ID, command acknowledgement, rover boot ID, or durable rover checkpoint.
- Resume created another mission record. The database could not express “mission 35, with the first 40 occurrences complete, now continuing the rest.”
- Completion was inferred from generic navigator state transitions, including an uncorrelated transition to `IDLE`.

The clearest failure sequence was:

| Mission | Stored evidence | What it demonstrates |
|---|---|---|
| 35 | 40 of 374 waypoint positions advanced | The original mission made partial progress. |
| 36 | All 374 coordinates were submitted again | Resume lost the completed prefix and attempted the course from the beginning. |
| 37 | 34 of 374 waypoint positions advanced | A second partial run reproduced the same problem. |
| 38 | A browser-sliced suffix of 340 coordinates was submitted and marked complete in 0.355 s | A stale/unrelated `IDLE` transition falsely completed a newly submitted mission before it drove the route. |
| 39 | All 374 coordinates were submitted again | The operator again had no trustworthy continuation state and fell back to restarting the full plan. |

The other records (33–34 and 40–47) do not add a different resume mechanism: they use the same coordinate-only payload and the same independent-record lifecycle. They therefore cannot prove which cone occurrence was completed after a pause, process restart, network interruption, or server restart.

## Root causes

1. The browser, server, and rover each held a different partial view of the mission. The browser decided what “remaining” meant by slicing a local array.
2. A resume request called the legacy execute endpoint and created a new mission, destroying continuity and auditability.
3. Array indexes were treated as progress identity. They change when a prefix is sliced, an item is reordered, or duplicate coordinates are removed.
4. The legacy path cleaner removed near-zero segments, so an intentional repeated visit to the same cone could disappear.
5. The server treated generic telemetry (`NAVIGATING`/`IDLE`) as mission lifecycle evidence without correlating it to a mission, plan, command, or rover boot.
6. The rover did not atomically persist mission identity and completed waypoint occurrences. A pilot/host restart could only reconstruct a route from a new browser command.
7. Pause, emergency stop, disconnect, and reboot did not have one explicit held-state contract. Some paths preserved memory, some rebuilt from browser state, and some auto-adopted movement.

## Redesign

Protocol v2 makes the server mission record authoritative and uses stable identity end to end:

- A mission owns ordered `mission_waypoint` occurrences. Every occurrence has a UUID; two visits to the same cone remain two distinct UUIDs.
- Each mission plan has a SHA-256 hash. Editing the remaining route requires the caller's last-read hash and rejects stale writes.
- Completed occurrences are immutable. Removing a pending occurrence records it as `skipped` with an audit reason; it is never silently deleted.
- Start, pause, resume, and end are durable commands with mission-local sequence numbers, command UUIDs, target rover boot IDs, delivery replay, and accepted/rejected acknowledgements.
- The rover atomically checkpoints mission ID, plan hash, command sequence, original mission start, ordered occurrences, and completed IDs before it moves and after every progress transition.
- Mission completion remains checkpointed as `completion_pending` until the server acknowledges the terminal report. If power is lost in either direction of that acknowledgement, the next boot replays completion or receives an authoritative reset; neither side can resurrect or forget the finished mission.
- A restored checkpoint always boots into `PAUSED`. Pause, emergency-stop clear, process reboot, and host reboot all require an explicit operator resume. Only a network reconnect from the same boot may reconcile an already-running checkpoint as running.
- Generic telemetry no longer advances or completes a v2 mission. Only correlated mission reports can do so.
- Manual non-zero control is rejected while autonomy is not held. A paused/interrupted mission permits manual repositioning without abandoning its checkpoint.
- Finish behavior is part of the hashed plan: stop at the last cone (default), or return to the original mission start recorded before initial motion.

## Route authoring

The operator can select any subset of the course cones, filter hundreds of cones by side/number/ID, add filtered results in bulk, auto-order from the live rover position, reverse, drag/reorder, move directly to a numbered position, remove occurrences, and explicitly add duplicate visits with a warning. Named per-course presets store the exact order and finish behavior. A deleted cone makes a preset visibly stale instead of silently changing its route.

## Verification criteria

The deterministic test suite covers:

- arbitrary subsets, ordering, presets, stale deleted cones, and explicit duplicates;
- no movement before command acknowledgement and no completion from stale `IDLE` telemetry;
- same mission ID across held-route edits and resume, with completed occurrences excluded;
- stale plan and stale boot rejection, immediate hold on a new boot identity, report replay idempotence, and manual-control gating;
- atomic checkpoint round-trip/corruption rejection, emergency-stop/reboot held recovery, edited-route resume, return-only resume, spray completion, and spray-timeout retry;
- completion acknowledgement crash-window recovery and protocol-v2 SSE command/report bridging with boot-scoped monotonic report sequences.
