# LoRa 타이밍 시스템 — 설계 (단일 겸용 보드)

KR920 LoRa 기반 시간동기 이벤트 측정 + 신호등 제어 시스템. **MCU = SuperMini nRF52840** (nice!nano 핀호환).
**하나의 PCB를 전부 실장**하고, **펌웨어로 역할만 전환**한다:

- **마스터 역할** — USB로 PC 연결, LoRa 비콘 송신 + 모든 센서의 이벤트·진단 수집, **신호등(SSR) 제어**, USB 시리얼 출력.
- **센서 역할** — 센서 1개 연결, 배터리 구동, 이벤트 HW 타임스탬프 → 마스터 시각 변환 → LoRa 송신 + 주기적 동기 진단 보고.

> 보드는 **항상 18650 장착**. 마스터는 USB가 충전+PC데이터, 센서는 배터리 구동.

---

## 1. 시스템 개요 & 토폴로지

- **마스터 1개 + 센서 최대 6개.** 전부 **하나의 채널**에서 **하나의 타임베이스**(마스터 TIMER1)를 공유.
- 센서가 이벤트 HW 타임스탬프 → 마스터 시각 변환 → 송신. 마스터가 모든 센서를 수집 → USB 시리얼로 PC(node_id 태그) + 신호등 제어.
- **여러 경기(세트)를 동시에 운용**하더라도 무선은 마스터 1개·채널 1개로 통합한다. 어느 센서가 어느 경기의 어느 역할(출발/도착/레인)인지의 **매핑은 서버/PC 측에서 설정**하고, 펌웨어는 node_id만 다룬다. 신호등은 마스터의 단일 SSR 출력 — 기본은 모든 경기가 **가상 신호등**(측정만)이고, 무선 설정에서 **지정한 1개 경기만 실제 SSR을 제어**한다.

```
                 마스터 ─USB→ PC (모든 node 수집, 신호등 SSR 제어)
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
| 신호등 = SSR | 램프(AC 220V)는 SSR이 끊음. 보드는 SSR 제어입력(저전류)만 |
| 타이밍 예산 ~1ms | 센서 응답 1ms가 바닥 |

---

## 2. 무선 & 동기 프로토콜 (MCU 무관)

### 2.1 무선 파라미터
KR920, **SF7 / BW250** (심볼 512µs), 고정 길이 패킷. 출력 **EIRP ≤ +14dBm** (안테나 ~2dBi → conducted ~+12dBm).

### 2.2 채널 계획
**단일 채널 921.3 MHz / BW250 / sync word 0x12.** 모든 노드(마스터 + 센서 전부)가 이 채널을 공유한다. SX1262는 한 번에 한 채널만 듣고 송신하므로(동시 다채널 불가) 채널 분리 대신 §2.8의 MAC(비콘 앵커 + node별 TDMA STATUS + 이벤트 CSMA)으로 충돌을 처리한다.

### 2.3 주소
**node_id가 유일한 식별자**: 마스터=0, 센서=1..6. set_id는 폐기(패킷에 없음). 센서→경기·역할 매핑은 서버/PC 설정값이며 펌웨어는 관여하지 않는다. 노드별 배열은 `MAX_NODES(=7)`로 잡고 node_id로 직접 인덱싱(`1 ≤ id < MAX_NODES`), 미등록 보드는 node_id `0xFF`로 두어 마스터가 무시한다.

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

### 2.6 패킷 (리틀엔디언, 고정 길이; set_id 없음)
모든 패킷은 §2.11의 AEAD로 봉인된다. 와이어 = **평문 보안헤더 + 암호화 페이로드 + MAC(16)**:
```
sec_hdr (평문, 인증됨) : type, node_id(송신자), boot_id(4), ctr(4)          = 10B
  + 암호화 페이로드:
    BEACON  : ver, seq, m_tx_prev(8), period_ms(2), slot_ms(2)              (14B)
    EVENT   : ev_seq(2), ev_master_t(8), master_boot_id(4), flags           (15B)
    ACK     : node_id(대상 센서), ev_seq(2)                                  (3B)
    STATUS  : seq, offset_tick(i64), skew_ppm(i32), rx_miss(2), beacon_gap(2), batt_mv(2), temp_c10(i16) (21B)
  + MAC(16, Poly1305)
→ 와이어 길이: BEACON 40, EVENT 41, ACK 29, STATUS 47 (B)
```
- 옛 CRC16은 폐기 — MAC이 비트오류 + 위변조를 모두 검출(§2.11).
- 보안헤더의 `node_id`는 **송신자**(0=마스터, 1..6=센서). ACK는 마스터가 보내므로 헤더 node_id=0이고, **대상 센서는 페이로드** node_id로 지정.
- EVENT의 ev_master_t = 노드가 미리 변환한 마스터 시각.
- EVENT의 master_boot_id = 이 이벤트가 동기된 마스터 세션 boot_id(추적 중인 비콘에서 학습). 마스터는 자기 현재 세션을 지칭하지 않는 이벤트를 거부 → 마스터 재부팅 후 이전 세션에서 캡처된 이벤트는 재전송 불가(§2.11).
- BEACON의 slot_ms = STATUS TDMA 슬롯 폭(ms, 정보용 — 센서는 컴파일타임 매크로로 스케줄, §2.8). ver = 프로토콜 버전(현재 4).
- STATUS = 센서가 자기 TDMA 슬롯에서 보내는 주기 진단(§2.10).
- 프로비저닝은 보드의 FICR.DEVICEID 정적 테이블(node_id.c)로 한다 — 과거의 over-air ID_SETUP 패킷은 폐기.

### 2.7 재동기 주기
표준 크리스털(~40ppm), 예산 1ms. 비콘 주기 = 노드 sync 주기 = **1s**(§2.8 프레임 앵커), beacon period 필드(`period_ms=1000`)로 통지.

### 2.8 충돌 처리 — 단일 채널 계층형 접근
AEAD 봉인으로 패킷당 26B(헤더10+MAC16)가 늘어 가장 큰 패킷(STATUS 47B)은 ~46ms, 비콘 40B는 ~41ms airtime(SF7/BW250/CR4-5, 옛 평문 ~31ms 대비). 세 종류 트래픽을 계층으로 분리해 서로 부딪치지 않게 한다:

1. **비콘 = 동기 앵커.** 마스터가 매 1s 프레임의 t=0에 송신. 각 센서의 비콘 RxDone이 그 프레임의 슬롯-0 기준.
2. **STATUS = node별 TDMA(센서가 시각 동기돼 있으므로 충돌 0).** 센서는 자기 비콘 RxDone(`prev_l_rx`)에서
   `slot_off_ms = TDMA_BASE_MS + (node_id−1)·SLOT_WIDTH_MS + STATUS_GUARD_MS` 만큼 뒤에 STATUS 송신.
   값 `TDMA_BASE_MS=80, SLOT_WIDTH_MS=90, STATUS_GUARD_MS=10`(config.h, §2.11 봉인 후 상향). 90ms 슬롯이 ~46ms airtime +
   1s당 클럭오차(<40µs) + Rx/Tx 전환을 흡수. 6센서 = 80+6·90 = 620ms로 1s 프레임 내. `STATUS_PERIOD_S(=5)` 프레임마다 한 번씩 라운드로빈으로 부하 분산.
3. **EVENT = 비동기 CSMA.** 이벤트는 예측 불가하므로 즉시 송신: **CAD(listen-before-talk) + 마스터 ACK + 재전송(≤4)**.
   백오프는 node로 디코릴레이트 `60 + ((ev_seq·7 + node·11) & 63) ms`, ACK 대기창 120ms(봉인된 EVENT 41B + ACK 29B 왕복 ~85ms 수용) → 두 센서가 동시에 쏴도 분리·복구. ev_master_t는 재전송에도 보존돼 복구된 이벤트도 정확. 재전송은 ev_seq 고정·ctr 갱신으로 다시 봉인(§2.11 — 동일 바이트 재전송은 replay로 거부되므로).

### 2.9 캘리브레이션 (T_air_ref)
고정 길이 → airtime 결정론. T_air_ref = TxDone↔RxDone 고정지연. 근거리 1회 측정 후 config.h `T_AIR_REF_TICKS`에 저장(현재 0 — 분할 타이밍엔 영향 없음, §2.5).

### 2.10 진단 (diagnostics)
센서·링크 상태를 마스터가 USB로 PC에 보고(§8 `D` 라인). 두 출처를 합친다:
- **센서 측(STATUS에 실어 업링크):** 현재 offset(`offset_tick`), 드리프트 `skew_ppm`(최근 ~8비콘 offset 링에서 산출), 누락 비콘 `rx_miss`/현재 연속 누락 `beacon_gap`.
- **마스터 측(수신 시 측정):** 패킷별 RSSI/SNR(`radio_receive_q` — readData 직후·재무장 전 `getRSSI(true)`/`getSNR()`), node별 last-seen(board_millis 기준 OK ≤10s(=2×STATUS_PERIOD_S) / STALE ≤15s / LOST), 무선 지연 `lat_ms = max(0, now − ev_master_t)/16000` (틱→ms, TICKS_PER_MS; 음수는 0 클램프).

### 2.11 무선 보안 — AEAD (기밀성 + 인증 + 재전송 방어)
raw LoRa는 평문이라 누구나 도청·위조할 수 있다. 위조 EVENT/BEACON으로 타이밍 결과나 신호등(SSR) 제어를 교란할 수 있으므로 모든 공중 패킷을 봉인한다. (USB↔PC 구간은 유선 신뢰 구간이라 대상 아님.)

- **원시(primitive):** XChaCha20-Poly1305 AEAD (Monocypher, vendored 단일 파일). 직접 조합한 암호 대신 검증된 1-함수 AEAD로 기밀성·무결성·송신자 인증을 한 번에.
- **키:** 플릿 공유 **사전공유키(PSK) 256-bit**, `src/secret.h`(gitignore). `secret.h.example`에서 복사해 운영자가 1회 생성, **마스터+모든 센서 동일 키로 플래시**. 키가 다르면 전 패킷 MAC 실패 → 통신 불가. 키 회전 = 전 보드 재플래시. CI/dev는 없으면 all-zero 플레이스홀더로 빌드만(경고 출력, 무보안).
- **인증 대상(AD) vs 암호화:** 평문 보안헤더(type/node_id/boot_id/ctr)는 AEAD의 associated data로 인증만(라우팅·replay 판단을 복호화 전에). 페이로드(타임스탬프·offset 등)는 암호화. MAC 16B가 옛 CRC16을 대체.
- **논스(절대 재사용 금지):** 24B = `domain | type | node_id | boot_id(4) | ctr(4)`. `ctr`은 송신마다 증가(부팅 내 유일), `boot_id`는 부팅마다 RNG 신규(재부팅 후 ctr가 0으로 돌아가도 논스 충돌 없음). node_id로 7송신자, domain으로 타용도와 분리. `ctr`은 wrap 직전 seal을 거부해 논스 재사용을 원천 차단(2³² seal은 세션 내 도달 불가).
- **재전송(replay) 방어 + 독립 재부팅 지원:** 수신자는 (송신자, 방향)별로 `(boot_id, max_ctr)`를 추적해 `ctr ≤ max_ctr`이면 거부. 마스터는 센서별, 센서는 마스터용 1개. **새 boot_id면 재기준(re-baseline)** — 이것이 마스터/센서의 독립 전원 재투입을 지원한다: 센서가 켜진 채 마스터를 뺐다 꽂으면(새 마스터 boot_id) 센서들이 비콘에서 재기준해 재동기하고, 반대로 마스터가 켜진 채 센서를 재부팅하면 마스터가 그 센서 창을 재기준한다. 어느 쪽을 언제 껐다 켜도 복구.
- **EVENT 마스터 세션 바인딩:** EVENT는 자신이 동기된 마스터 세션 `master_boot_id`(비콘에서 학습)를 실어 보내고, 마스터는 그 값이 자기 현재 boot_id가 아니면 거부. → 이전 마스터 전원주기에 캡처한 EVENT는 재부팅 후에도 재전송 불가(재기준만으로는 못 막는 cross-reboot EVENT replay를 암호학적으로 차단).
- **EVENT 신선도 백스톱:** 세션 바인딩 + replay 카운터에 더해, `ev_master_t`가 너무 과거(stale)거나 비현실적 미래면 거부. 정상 이벤트는 기껏 수ms 미래(동기오차)뿐이라 **비대칭** 창: 과거 `EVENT_FRESH_MS(3s)` / 미래 `EVENT_FUTURE_MS(250ms)`.
- **boot_id 엔트로피:** nRF52840 하드웨어 RNG(`NRF_RNG`, 바이어스 보정)로 부팅 시 32-bit 1회 시드(`sec_init`).
- **키 안전장치:** 릴리스/배포 빌드는 `-DFLEET_KEY_REQUIRED=ON`으로 빌드 — `src/secret.h`가 없거나 플레이스홀더(all-zero)면 빌드 실패시켜 무보안 펌웨어 출하를 막는다. dev/CI는 플래그 없이 플레이스홀더 자동 시드(경고만).
- **남는 한계(문서화):** EVENT는 세션 바인딩으로 cross-reboot replay까지 차단. BEACON/STATUS/ACK는 재부팅 후 캡처본 1개가 재기준으로 수용될 여지는 있으나 타이밍 위조 가치 없음(비콘은 seq+1 연속성 게이트로 offset 오염 안 됨 → DoS급). 32-bit boot_id의 두 코너: ① 충돌 시 nonce 재사용 ② 마스터가 같은 boot_id로 재부팅하면 센서가 그 비콘을 거부(센서 재부팅 전까지) — 둘 다 ~2⁻³²라 무시 가능, boot_id를 64-bit로 넓히면 완전 제거(선택). 구현: `src/secure.{h,c}`.

---

## 3. 핵심 하드웨어 결정

| 결정 | 내용 |
|---|---|
| MCU | **SuperMini nRF52840** (nice!nano 핀호환). 크리스털·DEC·DCC·3.3V LDO·충전기 모듈 내장 |
| 라디오 | **Ra-01SH** (SX1262), u.FL 안테나. 클럭/매칭/RF스위치 내장 |
| 전원 | **18650(보호셀) 상시** → VBAT. USB는 충전+PC데이터. 12V는 VBAT에서 부스트 |
| 신호등 | 외부 **SSR(SRS1-B1203-1) ×2**(적/녹). 보드는 SSR 제어전압(12V, ~10mA)만 |
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
| **신호등 RED** | P0.29 | 18 | 0 | GPIO out → SSR 적 |
| **신호등 GREEN** | P0.02 | 19 | 0 | GPIO out → SSR 녹 |
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
+12V ─→ 센서 커넥터 V+  /  신호등 드라이버 레일 (둘 다, 역할에 따라 사용)
USB ─→ (마스터) PC 데이터 + 충전 / (센서) 충전·플래시
```
- 부스트 입력 = **VBAT** → 마스터도 배터리 상시(USB 충전). 부스트 출력 = 1.233×(1+1M/110k) = **12.4V** (센서 12–24V·SSR 4–30V 둘 다 범위 내).
- 12V 부스트는 **공용**: 센서 역할 = 센서 급전, 마스터 역할 = SSR 제어전압. 동시 사용 안 함.

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

### 6.4 신호등 SSR 드라이버 — 마스터 역할 (색당 하이사이드 2-BJT)
```
[적] RED(P0.29) ─[R 10k]─ Q1n(MMBT3904) B ; Q1n E→GND ; Q1n C ─ Q1p(MMBT3906) B
     +12V ─[R 10k]─ Q1p B ; Q1p E→+12V ; Q1p C ─[R 100Ω]─ RD
[녹] GREEN(P0.02) → Q2n(MMBT3904) / Q2p(MMBT3906) → GN  (동일)

J_LIGHT(Molex 5569-04A1): 1 GND ; 2 NC ; 3 RD ; 4 GN     ← 옛 J5와 동일
  → 외부 SSR(SRS1-B1203-1) ×2: 적 control(+)=RD, 녹 control(+)=GN, 둘 다 control(−)=GND
  → SSR이 AC 220V를 신호등 적/녹 램프로 스위칭
```
하이사이드 2-BJT(P-FET Vgs 한계 회피, BJT는 Basic 부품). GPIO HIGH → NPN on → PNP on → 12V를 RD/GN으로. 신호등은 적 XOR 녹.

---

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
| Q1n·Q2n | NPN | MMBT3904 ×2 | C20526 · **Basic** | 신호등 드라이버 |
| Q1p·Q2p | PNP | MMBT3906 ×2 | **C7420354 · Preferred** | 신호등 하이사이드 (공급사 주의: 타 MMBT3906은 Extended) |
| R(드라이버) | 10k ×4, 100Ω ×2 | 0603 | Basic | base/직렬 |
| J_SENSOR | 센서 커넥터 | Molex 5569-04A1 | (Ext 예상) | [V+,NC,OUT,GND] 옛 J3/4 호환 |
| J_LIGHT | 신호등 커넥터 | Molex 5569-04A1 | (Ext 예상) | [GND,NC,RD,GN] 옛 J5 호환 |
| BT1 | 보호 18650 + 홀더 | — | off-board | 상시 장착 |
| — | SSR ×2 | Autonics SRS1-B1203-1 | off-board | 4–30VDC 제어 / 90–240VAC 3A |
| — | 센서 | Autonics BA2M-DDT | off-board | 12V NPN OC 1ms |
| ANT | u.FL→SMA + 920MHz 휩 | — | off-board | ~2dBi |

> JLC: 능동/수동 대부분 Basic/Preferred(무료). Molex 5569·MMBT는 카테고리 확인 필요. L1은 보유분 자가실장.

---

## 8. 펌웨어

RadioLib(커스텀 HAL) 기반. node_id로 역할 분기(0=마스터, 1..6=센서). 구현은 §2 프로토콜 + 아래 사양대로 (실제 코드는 펌웨어 프로젝트에 — 이 문서엔 사양만).

- **타임스탬프 캡처**: TIMER1 자유진행 16MHz = 공통 타임베이스. DIO1·SENSOR 엣지 → GPIOTE→PPI→TIMER CAPTURE (CPU 무관 HW 래치, 손실0). GPIOTE PSEL 설정 시 **해당 핀의 PORT 비트 포함**(P1 핀이면 bit13). port0/1 간 정확도 차이 없음.
- **라디오/SPI**: 할당 핀으로 커스텀 SPIClass. **`setRfSwitchPins(RXEN,TXEN)` 필수**. `begin(…, tcxoVoltage)`(내부 TCXO). 부팅 시 **EXT_POWER(P0.13) HIGH**.
- **센서 역할**: 비콘 동기 → 이벤트 캡처 → 마스터 시각 변환 → EVENT 송신(CAD+ACK+재전송) + 자기 TDMA 슬롯에서 STATUS 주기 송신.
- **무선 보안(§2.11)**: 전 패킷 XChaCha20-Poly1305 AEAD 봉인(Monocypher). 플릿 공유 PSK = `src/secret.h`(gitignore, `secret.h.example`에서 복사). 부팅 시 `sec_init()`로 RNG boot_id 시드. 구현 `src/secure.{h,c}`.
- **USB 프로토콜 (FSK-WL, 줄단위 텍스트, 레거시 `$...!` 폐기)**:
  - VID `0x1999` / **PID `0x0515`** / product **"FSK-WL"**. 호스트는 연결 후 `?ID`를 보내고 `I FSK-WL …` 응답으로 장치를 확인(PID와 무관한 핸드셰이크). 레거시 유선 앱(PID 0x0514)과 상호 비매칭.
  - 마스터→PC: `I FSK-WL <fw> <devid16> <freq_mhz> <sf> <bw> <ticks_per_ms>` · `H <now_tick> <uptime_ms> <beacon_seq> <nseen>` · `E <node> <ev_seq> <tmaster_tick> <flags> <rssi> <snr>` · `D <node> <OK|STALE|LOST> <offset_tick> <skew_ppm> <rx_miss> <beacon_gap> <last_seen_ms> <rssi> <snr> <lat_ms> <temp_c10> <batt_mv>` (node 0 = 마스터 자기보고: temp + 충전레일 batt_mv, LoRa 필드 0) · `L <RED|GREEN|OFF> <tick>` · `A <cmd> OK` · `X <reason>`.
  - PC→마스터: `G`(녹+green tick 캡처) · `R`(적) · `O`(off) · `?ID` · `?STATUS` · `PING`.
  - 64-bit tick은 십진수 그대로(절단 없음). 상태 = 온보드 LED(P0.15).
- NFC핀(P0.09/0.10)을 GPIO로 쓰면 **NFC 비활성화(UICR)** 필요.

---

## 9. 운용 (단일 마스터 / 멀티 경기)
- 마스터 1개·채널 1개·타임베이스 1개. 모든 센서가 같은 마스터 tick으로 보고되므로 어떤 센서쌍의 분할도 정밀.
- 마스터에 USB로 연결된 PC 1대가 **브리지 겸 콘솔**: 모든 node의 이벤트·진단을 수집해 서버로 push, 신호등을 제어. 다른 클라이언트는 서버(인터넷)에서 데이터를 받아 운용.
- 여러 경기를 동시에 돌리되 어느 node가 어느 경기·역할인지는 **서버 측 매핑 설정**으로 정한다. 신호등은 기본 가상이며 무선 설정에서 **지정한 1개 경기만 실제 SSR 제어**(그 경기는 신호등 점등 시점부터 측정). 프로비저닝(node_id 배정)은 보드 DEVICEID 테이블(node_id.c)로.

---

## 10. 검증·확인 (Open items)
- [ ] SuperMini LDO 전류 헤드룸 — 라디오(~60mA TX) + 부스트(센서 12V@15mA / SSR 12V@~10mA). 통상 ~300mA급, 실측 확인.
- [ ] SSR(SRS1-B1203-1) 제어 입력전류 — 12V에서 실제 mA(LDO·부스트 버짓).
- [ ] TXEN/RXEN 구동(setRfSwitchPins) — 실제 모듈 동작 확인.
- [ ] 부스트 PFM 안정성 실측.
- [ ] BA2M-DDT 12V 하한 / 온보드 LED(P0.15) 극성.
- [ ] Molex 5569-04A1 JLC 카테고리 확인 (MMBT3904=C20526 Basic, MMBT3906=C7420354 Preferred 확인됨).
- [ ] T_air_ref 실측(§2.9).
- [ ] P0.02/P0.29가 SuperMini에서 자유 GPIO인지 실물 확인.
- [ ] **배포 전 실 PSK 생성**(§2.11) — `src/secret.h`를 `openssl rand`로 만들어 전 보드 동일 키로 플래시. all-zero 플레이스홀더는 무보안.

---

## 11. KiCad
- 프로젝트: `device/wireless/hardware/fsk-traffic.kicad_sch`. 라이브러리 `device/wireless/hardware/lib/`:
  - 심볼 `SuperMini_NRF52840.kicad_sym` → **`SuperMini_nRF52840`(또는 `nice_nano`, 동일)** 배치.
  - 풋프린트 `SuperMini_NRF52840.kicad_mod`.
- A1 결선은 **핀 이름(P0.xx)** 으로. Ra-01SH·SSR·Molex 커넥터 심볼/풋프린트는 별도 추가 필요.

## 12. 범위 밖
PC측 수집/분석 SW, KiCad lib_id 실매핑, 기구/방수, 인증(KC), 세트 간 절대시각 정렬.
