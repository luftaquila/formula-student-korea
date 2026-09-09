# LoRa 타이밍 시스템 — 설계 (단일 겸용 보드)

KR920 LoRa 기반 시간동기 이벤트 측정 시스템. **MCU = SuperMini nRF52840** (nice!nano 핀호환).
**하나의 PCB를 전부 실장**하고, **펌웨어로 역할만 전환**한다:

- **마스터 역할** — USB로 PC 연결, LoRa 비콘 송신 + 모든 센서의 이벤트·진단 수집, USB 시리얼 출력.
- **센서 역할** — 센서 1개 연결, 배터리 구동, 이벤트 HW 타임스탬프 → 마스터 시각 변환 → LoRa 송신 + 주기적 동기 진단 보고.

> 보드는 **항상 18650 장착**. 마스터는 USB가 충전+PC데이터, 센서는 배터리 구동.

---

## 1. 시스템 개요 & 토폴로지

- **마스터 1개 + 센서 최대 6개.** 전부 **하나의 채널**에서 **하나의 타임베이스**(마스터 TIMER1)를 공유.
- 센서가 이벤트 HW 타임스탬프 → 마스터 시각 변환 → 송신. 마스터가 모든 센서를 수집 → USB 시리얼로 PC(센서 칩 ID 태그).
- **여러 경기(세트)를 동시에 운용**하더라도 무선은 마스터 1개·채널 1개로 통합한다. 어느 센서가 어느 경기의 어느 역할(출발/도착)인지의 **매핑은 서버/PC 측에서 설정**하고, 펌웨어는 node_id만 다룬다. 무선에는 물리 신호등이 없으며 경기별 시작·정지·초기화는 서버 세션 제어다.

```
                 마스터 ─USB→ PC (모든 node 수집)
                   │  단일 채널 921.3MHz, 단일 타임베이스
   ┌────────┬──────┼──────┬────────┬────────┐
 센서1    센서2   센서3   센서4   센서5   센서6
 (각자 고유 node_id, 마스터 비콘에 동기, 이벤트/진단 업링크)
```

### 설계 근거 (요약)
| 결정 | 이유 |
|---|---|
| LoRa 920MHz | 저높이(~50cm) 300m: 지면반사 손실 ~120dB → 2.4GHz 불가, LoRa 버짓만 감당 |
| SX1262(SPI) | DIO1 엣지 HW 캡처 필요 → UART 투명전송 모듈 불가. KR920 +14dBm라 PA(-P) 불필요 |
| nRF52840 | GPIOTE→PPI→TIMER HW 캡처가 결정론적 (C3 캡처 없음) |
| 겸용 단일보드 | 한 BOM·한 어셈블리, 역할은 펌웨어. 재고·제작 단순 |
| 타이밍 예산 ~1ms | 센서 응답 1ms가 바닥 |

---

## 2. 무선 & 동기 프로토콜 (MCU 무관)

### 2.1 무선 파라미터
KR920, **SF7 / BW250** (심볼 512µs), 고정 길이 패킷. 출력 **EIRP ≤ +14dBm** (안테나 ~2dBi → conducted ~+12dBm).

### 2.2 채널 계획
**단일 채널 921.3 MHz / BW250 / sync word 0x12.** 모든 노드(마스터 + 센서 전부)가 이 채널을 공유한다. SX1262는 한 번에 한 채널만 듣고 송신하므로(동시 다채널 불가) 채널 분리 대신 §2.8의 MAC(비콘 앵커 + 센서별 비콘-앵커 해시-오프셋 STATUS + 이벤트 CSMA)으로 충돌을 처리한다.

### 2.3 주소
**안정 식별자 = 칩 고유 ID(FICR.DEVICEID, 64-bit).** 하드코딩 테이블은 폐기 — 어떤 보드를 추가하든 꽂거나(센서는 전원만 넣어도) 자동 등록된다. set_id도 폐기(패킷에 없음). 센서→경기·역할 매핑은 서버/PC 설정값이며 펌웨어는 관여하지 않는다.

공중 패킷의 `node_id`는 **송신자 자신의 ID** — 칩 ID(FICR.DEVICEID) 하위 32비트다(마스터는 예약 ID 0). 슬롯·번호 개념이 없고 핸드셰이크도 없다: 센서는 자기 ID로 바로 송신하고, 마스터는 **첫 인증 패킷에서 그 ID를 처음 보면 레지스트리에 자동 등록**한다(`node_find_or_add`). PSK(플릿 키)가 멤버십 게이트이므로 키를 가진 보드만 등록된다(§2.11).

- 마스터 레지스트리는 `MAX_NODES(=7)` 엔트리의 **집합**(ID로 선형 탐색, 인덱스 의미 없음). 가득 차면 LOST 센서 자리를 회수, 그래도 없으면 신규는 무시.
- 마스터는 USB로 센서를 **그 ID(하위 32비트, 8-hex)**로 보고하고, 자기 ID는 `I` 라인에 전체 16-hex로 노출한다(§8). 사용자는 번호를 보거나 지정하지 않는다.
- 송신자 ID는 절대 0이 아니다(`node_sender_id()` — 하위 워드가 0이면 상위 워드로 폴백) → 센서가 마스터(예약 ID 0)로 오인되지 않는다. 6대 기준 하위 32비트 충돌 확률 ≈ 3.5e-9로 사실상 0.

### 2.4 타임베이스
각자 자유진행 TIMER(16MHz, 62.5ns), 32→64bit 소프트 확장. 노드는 로컬 tick→마스터 시각 매핑:
```
master_time = offset + local_tick                          (offset만)
master_time = offset + (local−L_ref)*(1+skew) + L_ref       (skew 보정 시)
```

### 2.5 동기 방식 — TX 타임스탬프 차기 비콘 전달 (단방향)
1. 마스터 비콘 N 송신 시 자기 DIO1(**TxDone**) 캡처 → M_tx[N].
2. 비콘 N 페이로드에 **M_tx[N-1]** + seq.
3. 센서는 비콘 N-1 수신 시 DIO1(**RxDone**) 캡처 L_rx[N-1] 저장(seq 키).
4. 비콘 N 도착 → `offset[N-1] = M_tx[N-1] + T_air_ref − L_rx[N-1]`.
5. (선택) `skew = (offset[k]−offset[k-1])/(L_rx[k]−L_rx[k-1])`.

공통 기준점 TxDone↔RxDone(둘 다 패킷 끝) → T_air_ref 작고 결정론적, 1회 캘리브레이션.

**세션 경계.** 마스터가 재부팅하면 새 boot_id로 비콘이 오는데, 그 마스터 TIMER는 0부터 다시 시작하므로 옛 offset/skew는 폐기된 타임베이스 기준이다. 센서는 **새 boot_id를 보면(일반 비콘 누락과 구분) 동기를 끊고(have_off=0, offset 링·skew 리셋) 그 비콘을 새 baseline으로** 잡는다 → 다음 연속 비콘이 새 세션 offset을 만들 때까지 이벤트를 내보내지 않아, stale offset이 새 세션에 바인딩되는 일이 없다. (boot_id는 RNG라 0도 유효값이므로 `have_master_session` 플래그로 첫 접속을 판별; master_boot_id==0을 sentinel로 쓰지 않는다.) 일반 비콘 누락(같은 세션)은 추정기를 보존한다(§2.8).

**이벤트 timestamp의 skew 보정.** 이벤트 시각은 `master_t = cur_off + ev_tick + (ev_tick − sync_ref_tick)·skew/1e6`로 변환한다 — **클럭 자체는 안 건드리고 변환에만** 적용. `sync_ref_tick`은 cur_off를 계산한 비콘의 RxDone(앵커). offset-only 대비 비콘 간 drift(≈skew·Δt; 18ppm이면 ~18µs/s, 비콘 누락 시 누적)를 제거한다. EVENT는 `|skew| ≤ SKEW_CLAMP_PPM`, 샘플 ≥ `SKEW_MIN_SAMPLES`, 측정 span ≥ `SKEW_MIN_DL_TICKS`, 앵커 이후 외삽 ≤ `SKEW_MAX_EXTRAP_MS`, `ev_tick ≥ sync_ref_tick`을 모두 만족할 때만 생성한다. 진단용 raw skew는 STATUS에 i16 클램프로만 보고해 RC fallback(~10000ppm) 같은 고장을 숨기지 않는다.

**동기 만료.** 마지막 유효 offset 앵커가 `SYNC_TTL_MS=7000`보다 오래되면 센서는 해당 캡처를 정상 EVENT로 확정하지 않고 유실 증거로 전달한다. 5초 STATUS 주기를 포함하면서도 ±40ppm인 두 XO의 최악 상대편차(80ppm)로 인한 추가 오차를 0.56ms 이하로 제한한다. EVENT에는 캡처 당시 `sync_age_ms`와 동기·skew·HFXO·캡처 상태 비트를 싣고 마스터가 다시 검사한다.

### 2.6 패킷 (리틀엔디언, 고정 길이; set_id 없음)
모든 패킷은 §2.11의 AEAD로 봉인된다. 와이어 = **평문 보안헤더 + 암호화 페이로드 + MAC(16)**:
```
보안헤더(평문, 인증됨) : vt(ver<<4 | type, 1B), boot_id(4), ctr(3)          = 8B (다운링크)
  업링크(EVENT/STATUS)만 + node_id(송신자 ID, 4B)                           = 12B
  + 암호화 페이로드:
    BEACON   : seq, m_tx_prev(8)                                          (9B)
    EVENT    : ev_seq(2), ev_master_t(8), master_boot_id(4), sync_age_ms(2), flags(1), capture_seq(4), end_seq(4), end_tick(8) (33B)
    ACK      : node_id(4), ev_seq(2), sensor_boot_id(4), ev_master_t(8) (18B)
    STATUS   : seq, offset_tick(i64), skew_ppm(i16), rx_miss(2), beacon_gap(u8), batt_mv(2), temp_c10(i16), sync_age_ms(2), capture_overflow(2), event_drop(2), flags (23B)
  + MAC(16, Poly1305)
→ 와이어 길이: BEACON 33, EVENT 61, ACK 42, STATUS 51 (B)
```
- 옛 CRC16은 폐기 — MAC이 비트오류 + 위변조를 모두 검출(§2.11).
- `vt` = 상위 니블 프로토콜 버전(현재 9) + 하위 니블 type. 별도 ver 바이트 없이 **모든 패킷이 버전 체크**를 받고, 불일치는 복호화 전에 거부.
- 보안헤더의 `node_id`는 **송신자의 32비트 ID**인데 **업링크(EVENT/STATUS)에만 실린다.** 다운링크(BEACON/ACK)는 항상 마스터(0)이므로 양측이 암묵적으로 0을 논스에 넣고 와이어에선 생략 → 비콘·ACK에서 4B 절약. ACK의 **대상 센서는 페이로드** node_id(32비트)로 지정.
- `ctr`은 와이어 24비트(2²⁴ seal = 1Hz로 194일, 세션 내 도달 불가; 논스엔 상위 0으로 확장).
- EVENT의 ev_master_t = 노드가 미리 변환한 마스터 시각.
- EVENT의 master_boot_id는 전체 uint32 세션 ID다. 센서 boot ID는 인증된 업링크 헤더에서 가져오며 USB·서버·ACK까지 보존한다.
- 비콘 주기·STATUS 주기는 양 역할이 **config.h 상수로 공유**하므로 더 이상 on-air로 싣지 않는다(옛 period_ms/status_period_ms 폐기).
- STATUS는 진단 필드를 right-size: skew_ppm은 i16(±32767ppm, 실 XO 충분), beacon_gap은 u8(255 포화).
- STATUS = 센서가 비콘 앵커 해시-오프셋으로 보내는 주기 진단(§2.8, §2.10).
- 역할은 USB(§8), 식별은 칩 ID로 정해진다 — 과거의 정적 DEVICEID 테이블(node_id.c)·over-air ID_SETUP 패킷은 모두 폐기.

### 2.7 재동기 주기
표준 크리스털(~40ppm), 예산 1ms. 비콘 주기 = 노드 sync 주기 = **1s**(§2.8 프레임 앵커), 양 역할이 config.h 상수로 공유(과거의 on-air period 필드는 폐기).

### 2.8 충돌 처리 — 단일 채널 계층형 접근
AEAD + 압축 헤더(다운링크 8B / 업링크 12B + MAC 16B)로 가장 큰 패킷(STATUS 51B)은 약 50ms, 비콘 33B는 ~36ms airtime(SF7/BW250/CR4-5). 세 종류 트래픽을 계층으로 분리해 서로 부딪치지 않게 한다:

**LBT(KR920 공동사용 — 송신 전 신호감지).** 모든 송신(비콘·EVENT·STATUS·ACK)은 직전에 `radio_lbt_clear()`로 채널을 감지한다. 구현은 **SX1262 CAD(`scanChannel`)** — LBT 도입 전 펌웨어가 EVENT/STATUS 백오프에 쓰던 검증된 채널 감지라 false-busy가 없다(순간 RSSI 에너지 감지를 시도했으나 `startReceive` 직후 ~0 dBm 기본값을 읽어 비콘을 굶겨 폐기). LoRa 프리앰블이 실제로 감지될 때만 busy로 보고, 그 외(스캔 오류 포함)는 clear. **busy일 때의 처리는 패킷 성격에 따라 다르다:** 재전송이 있는 EVENT는 다음 ACK 재시도로 미루고, 유실 관대한 STATUS는 그 사이클을 건너뛴다(give-up). **하지만 비콘은 재전송이 없는 동기 앵커라 절대 포기하지 않는다 — best-effort LBT**: 감지 후 busy면 `BEACON_LBT_TRIES`회까지 `BEACON_LBT_GAP_MS` 간격으로 재감지(창 길이 ≈ STATUS 1개 에어타임)하여 진행 중인 피어 송신이 끝나길 기다린 뒤, 그래도 안 비면 송신한다. "송신 전 감지"는 모든 송신에 성립하고(give-up만 bounded wait로 대체) — 과거의 무조건 skip은 채널이 바쁠 때 비콘을 통째로 버려 모든 센서가 동시에 누락(rx_miss 동반증가)·링크가 STALE로 노화하던 회귀였다. 대기는 동기 정확도에 무해(동기는 실제 TxDone 틱 기준)하고 채널이 ~95% 비어 거의 0이다. **트레이드오프:** CAD는 *우리 SF의 LoRa 활동*만 감지(임의 에너지 아님) — RRA 고시가 −65dBm 에너지 임계 LBT를 요구하면, 하드웨어로 검증한 순간-RSSI 경로가 별도로 필요하다(현재 deferred). 이로써 KR920의 LBT 옵션을 만족해 1Hz 비콘 airtime이 듀티사이클 한도에 묶이지 않는다. 세 종류 트래픽을 계층으로 분리한다:

1. **비콘 = 동기 앵커.** 마스터가 매 1s 프레임에 best-effort LBT 후 송신(busy면 bounded wait, 끝까지 안 비면 송신 — 절대 skip 안 함). 동기는 실제 TxDone 틱 기준이라 LBT 지연·지터가 정확도에 영향 없음. 각 센서의 비콘 RxDone으로 마스터 시각을 추정.
2. **STATUS = 비콘 앵커 + 고정 위상 + 재해시 오프셋(조정자 없는 충돌 내성).** 센서는 `STATUS_PERIOD_S(=5)` 비콘마다 한 번, **고정 위상의 비콘**(`prev_seq % 5 == 자기ID % 5` — 매 주기 같은 1/5 비콘)에 얹어, 그 **비콘 RxDone(`prev_l_rx`)으로부터의 오프셋** `offset = STATUS_GAP_GUARD_MS + hash(자기 ID, 주기) mod STATUS_GAP_SPAN_MS` (=200~700ms) 시점에 송신. 위상이 고정이라 **간격이 규칙적 ~5초 ±0.25초**(지터로 STALE 창에 근접하지 않음) — 옛 슬롯과 같은 규칙성이되 슬롯 번호 없이 칩 ID로 자가 배치. 비콘 간격(~1s)의 가드된 중앙에 놓이므로 **송신(=수신 불가) 중에 비콘이 도착하지 않는다** — SX1262는 반이중이라 송신 중엔 귀가 먹고, STATUS를 비콘 위에 얹으면 그 비콘을 놓친다(예전 절대-위상 방식의 회귀; 원래 슬롯 설계가 비콘-상대였던 이유). 오프셋만 **주기마다 재해시**라 같은 위상을 공유한 두 센서도 영구 충돌이 안 된다(자가회복). 송신 직전 **LBT/CAD**가 드문 동일-주기 근접 충돌을 지연으로 전환(busy면 그 주기 건너뜀 — STATUS는 유실 관대). 비콘(동기) 충돌은 앵커링으로 **구조적으로 0**, 센서-대-센서 STATUS 충돌만 드물게 남고 그건 유실 관대·자가회복.
3. **EVENT = 비동기 LBT + 종단 간 인계 확인.** 센서 ISR 캡처 링 뒤의 pending 큐(8개)가 이벤트 시각을 보존하고, LBT+120ms 무선 ACK를 성공할 때까지 80ms+jitter로 재시도한다(최대 보존 2.5초). 마스터는 이벤트를 RAM 큐(16개)에 넣은 **뒤에만** 무선 ACK하고, USB `E`를 반복한다. 브리지는 서버가 insert/dedupe한 정확한 `(node, seq, tick, master_boot_id, sensor_boot_id)`을 응답한 뒤 `C`로 확인하며, 그때만 마스터가 큐에서 제거한다. 센서의 큐 포화·만료는 유실 범위를 별도 EVENT로 ACK까지 보존한다. 마스터 큐 포화는 ACK를 보류해 센서 재시도를 유도하며 그 자체로 캡처 유실을 뜻하지 않는다. 누적 카운터는 진단용이다. 재전송은 ev_seq·ev_master_t 고정, ctr 갱신으로 다시 봉인한다(§2.11).

### 2.9 캘리브레이션 (T_air_ref)
고정 길이 → airtime 결정론. T_air_ref = TxDone↔RxDone 고정지연. 근거리 1회 측정 후 config.h `T_AIR_REF_TICKS`에 저장(현재 0 — 분할 타이밍엔 영향 없음, §2.5).

마스터 TIMER의 절대 주파수는 소프트웨어에서 임의 보정하지 않는다. 펌웨어는 실제 `HFCLKSTAT.SRC == Xtal`일 때만 계측을 시작하고, 마스터에서는 USB SOF 10초 창을 TIMER1에 PPI 캡처해 `usb_ref_ppm`을 진단한다. USB SOF 자체 허용오차(±500ppm) 때문에 이 값은 HFXO gross-fault/현장 추세 확인용일 뿐 SI 초 교정계수로 적용하지 않는다. 절대 scale 보정이 필요하면 외부 시간간격 기준기로 보드별 계수를 측정해야 한다.

### 2.10 진단 (diagnostics)
센서·링크 상태를 마스터가 USB로 PC에 보고(§8 `D` 라인). 두 출처를 합친다:
- **센서 측(STATUS에 실어 업링크):** 현재 offset(`offset_tick`), 드리프트 `skew_ppm`(최근 ~8비콘 offset 링에서 산출), 누락 비콘 `rx_miss`/현재 연속 누락 `beacon_gap`, `sync_valid`/`skew_valid`/`clock_source`, `sync_age_ms`, ISR 캡처 링 overflow와 EVENT 전달 drop.
- **마스터 측(수신 시 측정):** 패킷별 RSSI/SNR, STATUS 기준 last-seen(OK ≤10s / STALE ≤15s / LOST), 무선 지연, 호스트 인계 큐 depth/overflow, USB SOF 대비 HFXO 관측 ppm.
- **보안 관측(§2.11):** 조용히 버려지던 거부를 카운터로 노출 → 위조/키불일치/replay 탐지 가능. 글로벌 `auth_drop`(AEAD 검증 실패 — node 귀속 불가)는 node 0 자기보고 D 라인의 `sec_drop` 슬롯에, 센서별 `sec_drop`(인증후 replay/freshness/session-binding 거부)는 각 D 라인에, `provisioned`(키 보유 여부)는 모든 D 라인에 실린다. 카운터는 마스터가 USB로만 보고(공중 패킷·에어타임 불변). 서버는 ingest에서 증가분/미프로비저닝을 `wireless.security` 로그로 남긴다(`/api/logs`).

### 2.11 무선 보안 — AEAD (기밀성 + 인증 + 재전송 방어)
raw LoRa는 평문이라 누구나 도청·위조할 수 있다. 위조 EVENT/BEACON으로 타이밍 결과를 교란할 수 있으므로 모든 공중 패킷을 봉인한다. (USB↔PC 구간은 유선 신뢰 구간이라 대상 아님.)

- **원시(primitive):** XChaCha20-Poly1305 AEAD (Monocypher, vendored 단일 파일). 직접 조합한 암호 대신 검증된 1-함수 AEAD로 기밀성·무결성·송신자 인증을 한 번에.
- **키 — 런타임 프로비저닝(컴파일 안 함):** 플릿 공유 PSK 256-bit를 **빌드에 박지 않는다**. 각 보드의 예약 flash 페이지(`0xF3000`, keystore.c, magic+CRC32 검증)에 저장되고 부팅 시 로드되며, **USB 시리얼 `K <64hex>` 명령(write-only)으로 보드마다 1회 주입**한다(§8). → CI는 **키 없는 앱**만 빌드하므로 public repo 아티팩트가 노출돼도 안전. 키는 운영자 로컬에만 존재(repo·CI·채팅 금지). 마스터+전 센서 동일 키 필수(다르면 전 패킷 MAC 실패). 키 회전 = 보드별 재주입. flash 페이지는 앱 영역 최상단(linker FLASH에서 제외)이라 앱 DFU에도 보존.
- **인증 대상(AD) vs 암호화:** 평문 보안헤더(vt/boot_id/ctr, 업링크는 +node_id)는 AEAD의 associated data로 인증만(라우팅·replay 판단을 복호화 전에). 페이로드(타임스탬프·offset 등)는 암호화. MAC 16B가 옛 CRC16을 대체.
- **논스(절대 재사용 금지):** 24B = `domain | type | node_id | boot_id(4) | ctr(4)`. `ctr`은 송신마다 증가(부팅 내 유일), `boot_id`는 부팅마다 RNG 신규(재부팅 후 ctr가 0으로 돌아가도 논스 충돌 없음). node_id로 송신자 분리(다운링크는 마스터 0을 암묵 사용), domain으로 타용도와 분리. 와이어 `ctr`은 24비트로 보내되 논스엔 상위 0으로 확장하며, wrap 직전 seal을 거부해 논스 재사용을 원천 차단(2²⁴ seal=1Hz로 194일, 세션 내 도달 불가).
- **재전송(replay) 방어 + 독립 재부팅 지원:** 수신자는 (송신자, 방향)별로 `(boot_id, max_ctr)`를 추적해 `ctr ≤ max_ctr`이면 거부. 마스터는 센서별, 센서는 마스터용 1개. **새 boot_id면 재기준(re-baseline)** — 이것이 마스터/센서의 독립 전원 재투입을 지원한다: 센서가 켜진 채 마스터를 뺐다 꽂으면(새 마스터 boot_id) 센서들이 비콘에서 재기준해 재동기하고, 반대로 마스터가 켜진 채 센서를 재부팅하면 마스터가 그 센서 창을 재기준한다. 어느 쪽을 언제 껐다 켜도 복구.
- **EVENT 마스터 세션 바인딩:** EVENT는 자신이 동기된 마스터 세션 `master_boot_id`(비콘에서 학습)를 실어 보내고, 마스터는 그 값이 자기 현재 boot_id가 아니면 거부. → 이전 마스터 전원주기에 캡처한 EVENT는 재부팅 후에도 재전송 불가(재기준만으로는 못 막는 cross-reboot EVENT replay를 암호학적으로 차단).
- **EVENT 신선도 백스톱:** 세션 바인딩 + replay 카운터에 더해, `ev_master_t`가 너무 과거(stale)거나 비현실적 미래면 거부. 정상 이벤트는 기껏 수ms 미래(동기오차)뿐이라 **비대칭** 창: 과거 `EVENT_FRESH_MS(3s)` / 미래 `EVENT_FUTURE_MS(250ms)`.
- **boot_id 엔트로피:** nRF52840 하드웨어 RNG(`NRF_RNG`, 바이어스 보정)로 부팅 시 32-bit 1회 시드(`sec_init`).
- **미프로비저닝 동작:** 키가 없으면 `sec_provisioned()=0` → seal/unseal이 거부되어 보드는 무선 inert(비콘·이벤트 미전송, 잘못된 평문도 안 나감). 마스터는 USB로 `X noprov`를 주기 통지해 운영자가 알 수 있다. 시리얼 `K` 주입(+`sec_reload`) 즉시 활성(재부팅 불필요).
- **남는 한계(문서화):** EVENT는 세션 바인딩으로 cross-reboot replay까지 차단. BEACON/STATUS/ACK는 재부팅 후 캡처본 1개가 재기준으로 수용될 여지는 있으나 타이밍 위조 가치 없음(비콘은 seq+1 연속성 게이트로 offset 오염 안 됨 → DoS급). 32-bit boot_id의 두 코너: ① 충돌 시 nonce 재사용 ② 마스터가 같은 boot_id로 재부팅하면 센서가 그 비콘을 거부(센서 재부팅 전까지) — 둘 다 ~2⁻³²라 무시 가능, boot_id를 64-bit로 넓히면 완전 제거(선택). 구현: `src/secure.{h,c}`.

---

## 3. 핵심 하드웨어 결정

| 결정 | 내용 |
|---|---|
| MCU | **SuperMini nRF52840** (nice!nano 핀호환). 크리스털·DEC·DCC·3.3V LDO·충전기 모듈 내장 |
| 라디오 | **Ra-01SH** (SX1262), u.FL 안테나. 클럭/매칭/RF스위치 내장 |
| 전원 | **18650(보호셀) 상시** → VBAT. USB는 충전+PC데이터. 12V는 VBAT에서 부스트 |
| 라디오 노이즈 | 부스트는 VBAT에서 → 라디오는 LDO 뒤 3.3V(LDO가 부스트 리플 격리) → **FB 페라이트 불요** |

### SuperMini 패드 ↔ nRF52840 (물리 위치 — 레이아웃 참고)
> 외곽핀은 nice!nano와 동일 매핑. **결선은 §4의 핀 이름으로** (심볼 핀번호는 §4, marbastlib 기준).
```
pad 1  P0.06   pad 7  P0.22   pad 13 P0.09(NFC1)  pad 19 P0.29
pad 2  P0.08   pad 8  P0.24   pad 14 P0.10(NFC2)  pad 20 P0.31
pad 3  GND     pad 9  P1.00   pad 15 P1.11        pad 21 VCC(P0.13 게이트)
pad 4  GND     pad 10 P0.11   pad 16 P1.13        pad 22 RST
pad 5  P0.17   pad 11 P1.04   pad 17 P1.15        pad 23 GND
pad 6  P0.20   pad 12 P1.06   pad 18 P0.02        pad 24 P0.04(BATIN)
```
inner 3: P1.01/02/03 · 배터리: B+/B− · **온보드 LED = P0.15**.
**예약**: P0.13(EXT_POWER 게이트) · P0.04(BATIN) · P0.15(온보드 LED) · NFC(P0.09/0.10 미사용). **외부 QSPI 플래시 없음**(CircuitPython 보드정의 `INTERNAL_FLASH_FILESYSTEM` 확인) → SPI핀 충돌 없음.
**P0.24(RXEN)**: SuperMini 배터리분압 0201 풋프린트 **미실장 유지**(실장 시 RXEN과 충돌).

### Ra-01SH 핀아웃 (SMD16/ESP-12)
```
1 ANT  2 GND  3 3.3V  4 RESET  5 TXEN  6 DIO1  7 DIO2  8 DIO3
9 GND 10 BUSY 11 RXEN 12 SCK   13 MISO 14 MOSI 15 NSS  16 GND
```
- TXEN(5)·RXEN(11) = RF 스위치 → `setRfSwitchPins`로 구동 필수. DIO3(8) = 내부 TCXO → N/C, 펌웨어 tcxoVoltage. DIO2(7) N/C.
- ANT = 모듈 u.FL 커넥터에 안테나 직결, 캐리어 RF 미배선.

---

## 4. 핀 배정 (정본 — 핀 이름으로 연결)

핀# = marbastlib `SuperMini_nRF52840`(=`nice_nano`) 심볼 기준. **캡처핀(DIO1·SENSOR)이 port1** → GPIOTE에 PORT 비트 필요(정확도는 port0와 동일).

| 신호 | 핀 이름 | 심볼 핀# | 포트 | 용도 |
|---|---|---|---|---|
| LoRa SCK | P0.22 | 7 | 0 | SPIM (커스텀 SPIClass) |
| LoRa MISO | P0.20 | 6 | 0 | SPIM |
| LoRa MOSI | P0.17 | 5 | 0 | SPIM |
| LoRa NSS | P0.08 | 2 | 0 | GPIO CS |
| LoRa BUSY | P1.00 | 9 | 1 | GPIO in |
| **LoRa DIO1** | **P1.06** | 12 | **1** | **GPIOTE 캡처** (Tx/RxDone) — PORT 비트 |
| LoRa NRST | P0.11 | 10 | 0 | 라디오 리셋 (보드 RST 핀 아님) |
| LoRa TXEN | P1.04 | 11 | 1 | RF 스위치 TX en |
| LoRa RXEN | P0.24 | 8 | 0 | RF 스위치 RX en (P0.24 분압 0201 미실장) |
| **SENSOR IN** | **P1.11** | 22 | **1** | **GPIOTE 캡처**(falling) — PORT 비트, 센서 역할 |
| 상태 LED | P0.15 | (온보드) | 0 | 온보드 LED (펌웨어 표시) |
| 라디오 전원 | `3V3` | 16 | — | RA_VCC |
| 배터리 | `BAT+` | 13/29 | — | VBAT |
| GND | `GND` | 3/4/14/28 | — | |
| EXT_POWER | P0.13 | (핀없음) | 0 | VCC enable — 부팅 시 HIGH (§8) |

---

## 5. 전원 아키텍처 (단일 보드, 모든 역할 공통)

```
18650(보호셀) ─ VBAT ─┬─→ SuperMini B+ (온보드 충전기+LDO → 3V3, 스위치드)
                      └─→ TPS61040 부스트 ─[L1/D1, R1·R2]─ +12V
3V3 ─[100n+10µ]─→ Ra-01SH VCC        (LDO 뒤라 부스트 리플 격리, 페라이트 불요)
3V3 ─→ 센서 풀업(R3)
+12V ─→ 센서 커넥터 V+
USB ─→ (마스터) PC 데이터 + 충전 / (센서) 충전·플래시
```
- 부스트 입력 = **VBAT** → 마스터도 배터리 상시(USB 충전). 부스트 출력 = 1.233×(1+1M/110k) = **12.4V** (센서 12–24V 범위 내).
- 12V 부스트는 센서 급전에 사용한다.

---

## 6. 넷리스트 (KiCad 전사용 — A1 핀은 이름으로 연결)

`A1`=SuperMini, `U1`=Ra-01SH.

### 6.1 MCU ↔ 라디오 (+디커플)
```
RA_VCC : A1(3V3) ─ U1.3(3V3) ; C_dec1(100nF→GND) ; C_dec2(10µF→GND)   ← U1 옆 배치
GND    : A1(GND), U1.2/9/16(GND), 모든 GND
SCK    : A1(P0.22) ─ U1.12      MISO : A1(P0.20) ─ U1.13
MOSI   : A1(P0.17) ─ U1.14      NSS  : A1(P0.08) ─ U1.15
BUSY   : A1(P1.00) ─ U1.10      DIO1 : A1(P1.06) ─ U1.6 (캡처, port1)
NRST   : A1(P0.11) ─ U1.4       TXEN : A1(P1.04) ─ U1.5     RXEN : A1(P0.24) ─ U1.11
DIO2   : U1.7 N/C    DIO3 : U1.8 N/C    ANT : U1 u.FL 커넥터(캐리어 미배선)
```

### 6.2 전원 / 12V 부스트
```
배터리: BT1(+) [보호18650] ─ VBAT ─ A1(BAT+) ; BT1(−) ─ GND ─ A1(GND)
부스트 (TPS61040, U2 / SOT-23-5: 1=SW 2=GND 3=FB 4=EN 5=VIN):
  VBAT ─ Cin(10µF/16V→GND)
  VBAT ─ L1(22µH) ─ U2.1(SW)
  VBAT ─ U2.5(VIN) ; VBAT ─ U2.4(EN)   ;  U2.2(GND) ─ GND
  U2.1(SW) ─ D1(B5819W: A→SW, K→+12V)
  +12V ─ Cout(10µF/25V→GND)
  +12V ─ R1(1M) ─ U2.3(FB) ─ R2(110k) ─ GND        (→ 12.4V)
  Cff(~47pF C0G) ∥ R1  (+12V↔U2.3 FB)              필수 — 단일펄스/리플. FB 리플 ~50mVpp로 튜닝
```

### 6.3 센서 프런트엔드 (BA2M-DDT, NPN OC) — 센서 역할
```
J_SENSOR(Molex 5569-04A1): 1 V+ ←+12V ; 2 NC ; 3 OUT ; 4 GND
  J_SENSOR.3(OUT) ─ R4(330Ω) ─ SENSE
  SENSE ─ R3(4.7k) ─ 3V3 (풀업)
  SENSE ─ D2(BAT54S 클램프: →3V3 / →GND)
  SENSE ─ C9(100pF→GND, RF 바이패스)
  SENSE ─ A1(P1.11)   (port1 — GPIOTE PORT 비트)
```
NPN OC: 평소 풀업 H, 검출 시 GND 싱크 → falling 캡처. R4+D2(BAT54S 클램프)가 2m 케이블 ESD/트랜지언트 보호. (옵토 불요 — 센서가 보드와 전원·GND 공유.)


## 7. BOM (단일 보드 — 전부 실장)

LCSC#·분류 = JLCPCB API(`preferredComponentFlag`). Basic·Preferred = 셋업 수수료 없음.

| Ref | 부품 | MPN/값 | LCSC# · JLC | 비고 |
|---|---|---|---|---|
| A1 | MCU 모듈 | SuperMini nRF52840 | 별도조달 | nice!nano 핀호환 |
| U1 | LoRa 모듈 | Ra-01SH | 별도조달 | u.FL |
| U2 | 부스트 IC | TPS61040DBVR | C7722 · **Pref** | 12V |
| L1 | 파워인덕터 22µH | 보유분(220) | 자가실장 | Isat≥0.5A |
| D1 | 쇼트키 | B5819W | C8598 · **Basic** | 부스트 정류 |
| R1/R2 | 1MΩ / 110kΩ | 0603 | C22935·**Basic** / C25805·**Pref** | 부스트 분압→12.4V |
| Cin/Cout | 10µF/16V · 10µF/25V | 0805 X5R | Basic | 부스트 입·출력 (Cout 세라믹 DC 디레이팅 감안) |
| Cff | ~47pF C0G | 0603 | Basic | 부스트 피드포워드 (R1 양단, 필수) |
| C(Ra) | 100nF + 10µF | 0603/0805 | Basic | 라디오 디커플 |
| R3/R4 | 4.7k / 330Ω | 0603 | Basic | 센서 풀업/직렬 |
| D2 | BAT54S 클램프 | (C7420333) | **Pref** | 센서 입력 보호 |
| C9 | 100pF | 0603 | Basic | 센서 핀 RF 바이패스 |
| R(드라이버) | 10k ×4, 100Ω ×2 | 0603 | Basic | base/직렬 |
| J_SENSOR | 센서 커넥터 | Molex 5569-04A1 | (Ext 예상) | [V+,NC,OUT,GND] 옛 J3/4 호환 |
| BT1 | 보호 18650 + 홀더 | — | off-board | 상시 장착 |
| — | 센서 | Autonics BA2M-DDT | off-board | 12V NPN OC 1ms |
| ANT | u.FL→SMA + 920MHz 휩 | — | off-board | ~2dBi |

> JLC: 능동/수동 대부분 Basic/Preferred(무료). Molex 5569·MMBT는 카테고리 확인 필요. L1은 보유분 자가실장.

---

## 8. 펌웨어

RadioLib(커스텀 HAL) 기반. **역할은 USB로 분기** — 부팅 후 ROLE_SETTLE_MS 안에 USB 호스트(PC)가 enumerate하면 마스터, 아니면 센서. VBUS 전원만으로는 판정하지 않는다(센서도 충전·플래시 때 USB에 꽂히므로 — 더미 충전기는 enumerate하지 않음). **역할은 부팅 시 1회만 판정한다 — 실시간 재확인/자동 리셋은 없다.** (호스트가 CDC 포트를 점유하지 않으면 USB가 suspend되며 `tud_mounted()`가 false로 떨어지는데, 거기에 자동 리셋을 걸었더니 마스터가 주기적으로 재부팅해 비콘 seq가 리셋되고 동기가 깨졌다 — 폐기. 역할 변경은 보드 리셋/전원 사이클로.) 구현은 §2 프로토콜 + 아래 사양대로 (실제 코드는 펌웨어 프로젝트에 — 이 문서엔 사양만).

- **타임스탬프 캡처**: TIMER1 자유진행 16MHz = 공통 타임베이스. DIO1·SENSOR 엣지 → GPIOTE→PPI→TIMER CAPTURE(타임스탬프 시점은 CPU 무관). SENSOR GPIOTE ISR이 CC 값을 16칸 링버퍼로 옮겨 송신/ACK 대기 중 후속 엣지가 앞 값을 덮지 못하게 하며, overflow는 누적 진단과 해당 캡처 순번·시각의 유실 범위로 보고한다. GPIOTE PSEL 설정 시 **해당 핀의 PORT 비트 포함**(P1 핀이면 bit13).
- **클럭 fail-closed**: 부팅 후 실제 HFCLK source가 Xtal인지 확인하고, RC면 radio/TIMER1 계측을 시작하지 않는다. USB SOF 캡처는 마스터 HFXO의 상대 ppm 진단만 하며 타임베이스를 discipline하지 않는다(§2.9).
- **라디오/SPI**: 할당 핀으로 커스텀 SPIClass. **`setRfSwitchPins(RXEN,TXEN)` 필수**. `begin(…, tcxoVoltage)`(내부 TCXO). 부팅 시 **EXT_POWER(P0.13) HIGH**.
- **센서 역할**: 자기 칩 ID로 송신(별도 등록 단계 없음, §2.3) → 비콘 동기 → 이벤트 캡처 → 마스터 시각 변환 → EVENT 송신(LBT+ACK+재전송) + 비콘 앵커 해시-오프셋으로 STATUS 주기 송신(§2.8). 모든 송신 전 LBT(§2.8).
- **무선 보안(§2.11)**: 전 패킷 XChaCha20-Poly1305 AEAD 봉인(Monocypher). 플릿 PSK는 컴파일하지 않고 flash keystore(`0xF3000`)에서 로드 — 시리얼 `K` 명령으로 보드별 주입. 부팅 시 `sec_init()`가 boot_id 시드 + 키 로드. 구현 `src/secure.{h,c}` + `src/keystore.{h,c}`.
- **USB 프로토콜 (FSK-WL, 줄단위 텍스트, 레거시 `$...!` 폐기)**:
  - VID `0x1999` / **PID `0x0515`** / product **"FSK-WL"**. 호스트는 연결 후 `?ID`를 보내고 `I FSK-WL …` 응답으로 장치를 확인(PID와 무관한 핸드셰이크). 레거시 유선 앱(PID 0x0514)과 상호 비매칭.
  - 마스터→PC: `I FSK-WL <fw> <devid16> <freq_mhz> <sf> <bw> <ticks_per_ms>` · `H <now_tick> <uptime_ms> <beacon_seq> <nseen>` · `E <node> <ev_seq> <tick> <flags> <rssi> <snr> <master_boot_id> <sensor_boot_id> <capture_seq> <end_seq> <end_tick> <sync_age_ms>` · `D <node> <OK|STALE|LOST> <offset_tick> <skew_ppm> <rx_miss> <beacon_gap> <last_seen_ms> <rssi> <snr> <lat_ms> <temp_c10> <batt_mv> <sec_drop> <provisioned> <sync_valid> <skew_valid> <XTAL|RC> <sync_age_ms> <capture_overflow> <event_drop> <queue_depth> <queue_overflow> <usb_ref_valid> <usb_ref_ppm> <sensor_boot_id> <master_boot_id>`.
  - PC→마스터: `?ID`, `?STATUS`, `PING`, `K <64hex>`, `T <request_id>`(현재 tick·boot ID 응답), `C <0|node8hex> <ev_seq> <tick> <master_boot_id> <sensor_boot_id>`(서버 저장 확인; 정확한 큐 head만 제거).
  - **프로비저닝:** `K`/`?ID`/`PING`은 **센서도 수용**(역할·무선 상태 무관). 각 보드를 USB로 꽂아 `K <64hex>` 1회 전송 → keystore에 기록·즉시 활성. 키 read-back 명령 없음(시리얼 유출 불가).
  - USB 노드 ID는 마스터 `0`, 센서 8자리 hex다. EVENT·진단·서버 ACK에서 같은 표기를 사용한다.
  - 64-bit tick은 십진수 그대로(절단 없음). 상태 = 온보드 LED(P0.15).
- NFC핀(P0.09/0.10)을 GPIO로 쓰면 **NFC 비활성화(UICR)** 필요.
- **펌웨어 업로드 (DFU)**: 부트로더 = nice!nano(Adafruit nRF52, S140 v6.1.1). 앱은 **0x26000**에 링크(S140 user-app base; `linker/nrf52840_app.ld`). 키스토어 페이지 `0xF3000`은 linker FLASH 길이에서 제외돼 앱 DFU에 보존(§2.11).
  - **Linux에서 UF2 드라이브로 `cp`/`dd`는 플래시 안 됨** — 쓰기는 성공해도 이 부트로더는 플래시하지 않는다(RP2040과 다름). UF2 드래그앤드롭은 Windows 전용.
  - 플래시 = **부트로더 CDC로 serial DFU**, sudo 불필요(유저가 `dialout`):
    1. 펌웨어 = CI 아티팩트(`traffic-device.yml` → `traffic-device-firmware`의 `.bin`)를 `0x26000` 오프셋으로 hex 변환 → `adafruit-nrfutil dfu genpkg --dev-type 0x0052 --application <hex> pkg.zip`.
    2. **부트로더 진입(버튼 없이)**: 앱 CDC를 **1200 baud로 열고 DTR drop** → 앱이 `NRF_POWER->GPREGRET=0x57` 설정 후 리셋(`src/usb.c`). 부트로더가 새 `/dev/ttyACM*` + UF2 매스스토리지로 재등장. 앱이 행(hang)이면 물리 RST 더블탭.
    3. `adafruit-nrfutil dfu serial --package pkg.zip -p /dev/ttyACM<부트로더> -b 115200 --singlebank` → `Device programmed.` 후 앱이 부팅하며 FSK-WL CDC로 복귀.
- **프로비저닝 절차 (§2.11·§10)**: `openssl rand -hex 32`로 플릿 키 1개 생성(마스터+전 센서 **동일** 키) → 운영자 로컬에만 보관(repo/CI/chat 금지) → 각 보드 플래시 후 앱 CDC(115200)로 `K <64hex>` 전송 → `A K OK`. write-only(read-back 없음). 미주입 마스터는 `X noprov` 주기 송신, 센서는 USB 무출력(명령 응답만).

---

## 9. 운용 (단일 마스터 / 멀티 경기)
- 마스터 1개·채널 1개·타임베이스 1개. 모든 센서가 같은 마스터 tick으로 보고되므로 어떤 센서쌍의 분할도 정밀.
- USB 브리지 한 대가 모든 센서 증거를 전달한다. 각 경기 lease 보유자는 어느 PC에서나 시작·정지·초기화한다. 팀·이벤트·필수 센서 역할은 START 시 런에 고정한다.
- START는 최신 동기·HFXO·skew 및 건강한 checkpoint와 마스터 시각을 확인한다. 비콘 누락 횟수·누적 캡처 오류·큐 역압 카운터만으로 시작을 막거나 진행 런을 중단하지 않는다. 오래된 진단·미도착 캡처는 수집하면서 확인을 기다린다.
- 센서 ISR은 손실된 엣지를 포함하여 `capture_seq`를 증가시킨다. 정상 캡처(flags=15), 유실 범위(16), checkpoint(32), 시각 불명(64)은 기존 EVENT ACK/재전송 큐를 공유한다. 캡처의 `end_seq/end_tick`은 자기 값이고 유실은 범위 끝이다. checkpoint는 앞선 증거가 ACK되고 ISR 큐도 비었을 때만 주기적으로 생성한다. 누적 진단은 손실 증거를 대체하지 않는다.
- 서버는 모든 소스의 연속 순번과 checkpoint로 검증된 구간만 계산한다. ACK만 유실되어 정상 캡처와 유실 통보가 겹치면 실제 캡처를 우선한다. 확인 전에는 `pending`; 실제 유실·시계 오류·boot 변경은 영향 구간을 `invalid`로 끝내되 그 이전에 확정된 기록은 보존한다. 다음 정상 START로 복구한다. 센서 HFXO 오류 뒤에는 기존 offset/skew를 폐기하고 새 동기 샘플을 확보한 후 정상 캡처를 재개한다. 마스터 HFXO 오류 후 회복은 타임베이스 세션을 갱신해 센서 재동기를 유도하며, 이전 세션 큐의 서버 ACK는 계속 처리한다.
- 공식 결과는 서버가 원시 tick 차이를 구한 후 한 번 ms 반올림한다. 경기별 최소·최대 시간 제한은 없다. 원시 차이가 양수이면 0ms로 반올림되어도 허용한다. 브라우저는 서버 결과·랩을 표시하며 독자적으로 공식 결과를 산출하지 않는다.
- 원본 증거·런 상태·공식 기록·판정은 한 SQLite 트랜잭션으로 반영한다. 성공 후에만 ACK/SSE를 발행한다. 런 상태는 DB에서 읽고 해당 트랜잭션에서 바뀐 런만 저장한다.
- v9는 v8과 호환되지 않는다. 서버·웹 브리지·마스터·전 센서 펌웨어를 함께 갱신한다. 업그레이드 때 검증 증거가 없는 진행 런은 닫고 기존 공식 기록은 보존한다.

---

## 10. 검증·확인 (Open items)
- [ ] SuperMini LDO 전류 헤드룸 — 라디오(~60mA TX) + 부스트(센서 12V@15mA). 통상 ~300mA급, 실측 확인.
- [ ] TXEN/RXEN 구동(setRfSwitchPins) — 실제 모듈 동작 확인.
- [ ] 부스트 PFM 안정성 실측.
- [ ] BA2M-DDT 12V 하한 / 온보드 LED(P0.15) 극성.
- [ ] T_air_ref 실측(§2.9).
- [ ] **배포 전 키 주입**(§2.11) — `openssl rand -hex 32`로 생성한 1개 키를 각 보드에 시리얼 `K <64hex>`로 주입(마스터+전 센서 동일). 키는 로컬 전용, repo/CI 금지. 미주입 보드는 무선 inert.

---

## 11. KiCad
- 프로젝트: `device/wireless/hardware/fsk-traffic.kicad_sch`. 라이브러리 `device/wireless/hardware/lib/`:
  - 심볼 `SuperMini_NRF52840.kicad_sym` → **`SuperMini_nRF52840`(또는 `nice_nano`, 동일)** 배치.
  - 풋프린트 `SuperMini_NRF52840.kicad_mod`.
- A1 결선은 **핀 이름(P0.xx)** 으로. Ra-01SH·센서 커넥터 심볼/풋프린트는 별도 추가 필요.

## 12. 범위 밖
PC측 수집/분석 SW, KiCad lib_id 실매핑, 기구/방수, 인증(KC), 세트 간 절대시각 정렬.

## 정확도 검증 절차

소프트웨어 테스트 통과는 실물 정확도 교정 결과가 아니다. 배포 전 외부 기준 타이머와 동일 펄스를 센서 입력에 공급해 START/FINISH와 다중 랩의 원시 tick 차이를 비교한다. 짧은 구간과 긴 구간, 비콘 직후와 직전, 온도 변화, 비콘 연속 누락, 최대 노드 수·전송 부하, USB/HTTP 지연·재연결 조건을 반복한다. 조건별 표본 수·평균 오차·최대 절대 오차·분산을 기록하고 offset, skew, HFXO/USB SOF 진단을 함께 보존한다. TxDone/RxDone 고정 편차는 외부 기준으로 측정한 뒤에만 보정한다. 유실·시계 전환·재부팅을 주입해 영향 구간의 보류/무효 판정과 다음 START 복구를 확인한다. 합격 오차 예산과 외부 기준기의 불확도를 별도로 명시하며 실측 없이 1ms 정확도를 보장하지 않는다.
