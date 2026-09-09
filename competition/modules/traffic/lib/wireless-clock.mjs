import crypto from "node:crypto";

// The arm boundary must be captured after the request reaches the master.
// A cached heartbeat (or the operator PC's clock) cannot fence queued edges.
export function createWirelessClock({ send, timeoutMs = 5000 }) {
  const pending = new Map();
  return {
    read() {
      if (pending.size >= 8) return Promise.reject(new Error("마스터 시각 확인 요청이 너무 많습니다."));
      return new Promise((resolve, reject) => {
        const request_id = crypto.randomBytes(16).toString("hex");
        const timer = setTimeout(() => {
          pending.delete(request_id);
          reject(new Error("마스터의 경기 시작 시각을 확인하지 못했습니다."));
        }, timeoutMs);
        timer.unref?.();
        pending.set(request_id, { resolve, reject, timer });
        try {
          send({ action: "clock", request_id });
        } catch (error) {
          pending.delete(request_id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    accept({ request_id, master_tick, master_boot_id }) {
      const request = pending.get(request_id);
      if (!request) return false;
      pending.delete(request_id);
      clearTimeout(request.timer);
      request.resolve({ master_tick, master_boot_id });
      return true;
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("마스터 시각 확인이 종료되었습니다."));
      }
      pending.clear();
    },
  };
}
