# LoRa 타이밍 시스템 — 설계 (nice!nano v2 통합본)

KR920 LoRa 기반 시간동기 이벤트 측정 시스템의 **단일 통합 스펙** — 시스템·프로토콜·하드웨어·펌웨어.
MCU = **nice!nano v2** 확정. 핀맵·BOM은 nice!nano v2 기준.

---

## 1. 시스템 개요 & 토폴로지

- **세트 = 마스터 1 + 센서 2.** 동시 **2~3 세트** 독립 운용.
- 각 세트 = 전용 주파수 채널 + 자기 타임베이스(그 세트 마스터). 세트 간 RF·시각 **독립**(그랜드마스터 없음). 세트 내(마스터+센서2)에서만 정밀.
- 센서가 이벤트를 HW 타임스탬프 → 마스터 시각으로 변환 → 송신. 마스터가 수집 → USB 시리얼로 PC 출력(set_id 태그).

```
세트 A (921.3MHz)      세트 B (922.1MHz)      세트 C (922.9MHz)
 마스터A ─USB┐          마스터B ─USB┐          마스터C ─USB┐
  센서A1     │           센서B1     │           센서C1     │ → PC
  센서A2     ┘           센서B2     ┘           센서C2     ┘
 (독립 채널·독립 타임베이스, 세트 간 동기 없음)
```

### 설계 근거 (요약)
| 결정 | 이유 |
|---|---|
| LoRa 920MHz | 저높이(~50cm) 300m: 지면반사(2선 d⁴) 손실 ~120dB → 2.4GHz 불가, LoRa 버짓만 감당 |
| SX1262 (SPI) | DIO1 엣지 HW 캡처 필요 → UART 투명전송 모듈 불가. KR920 +14dBm라 PA(-P) 불필요 |
| nRF52840 | GPIOTE→PPI→TIMER HW 캡처가 결정론적·성숙 (C3 캡처 없음) |
| 무게이팅(상시 ON) | 배터리 마진 충분, 게이팅 시 워밍업 churn + 놓친 이벤트 복구 불가 |
| 타이밍 예산 ~1ms | 센서 응답 1ms가 바닥, 그보다 빡빡할 이유 없음 |
| 세트별 채널 | 주파수 분리가 가장 깨끗한 세트 격리 |

---

## 2. 무선 & 동기 프로토콜 (MCU 무관 — 그대로 적용)

### 2.1 무선 파라미터
KR920, **SF7 / BW250** (심볼 512µs), 고정 길이 패킷. 출력 **EIRP ≤ +14dBm** (안테나 ~2dBi → conducted ~+12dBm).

### 2.2 채널 계획 (세트 격리)
| 세트 | set_id | 주파수(BW250) | sync word |
|---|---|---|---|
| A | 0 | 921.3 MHz | 0x12 |
| B | 1 | 922.1 MHz | 0x12 |
| C | 2 | 922.9 MHz | 0x12 |

~800kHz 간격(250kHz 폭 + 가드) → 겹침 0. 센서는 자기 채널만 청취.

### 2.3 주소
**set_id**(0~2) + **node_id**(마스터=0, 센서=1·2). 채널이 1차 격리, set_id 보강.

### 2.4 타임베이스
노드/마스터 각자 자유진행 TIMER(16MHz, 62.5ns). 32-bit→64-bit 소프트 확장(sync 주기마다 read되어 268s wrap 추적). 노드는 로컬 tick→마스터 시각 매핑(TIMER 리셋 안 함):
```
master_time = offset + local_tick                          (offset만)
master_time = offset + (local−L_ref)*(1+skew) + L_ref       (skew 보정 시)
```

### 2.5 동기 방식 — TX 타임스탬프 차기 비콘 전달 (단방향)
1. 마스터 비콘 N 송신 시 자기 DIO1(**TxDone**) 캡처 → M_tx[N].
2. 비콘 N 페이로드에 **M_tx[N-1]** + seq.
3. 센서는 비콘 N-1 수신 시 DIO1(**RxDone**) 캡처 L_rx[N-1] 저장(seq 키).
4. 비콘 N(M_tx[N-1] 포함) 도착 → `offset[N-1] = M_tx[N-1] + T_air_ref − L_rx[N-1]`.
5. (선택) `skew = (offset[k]−offset[k-1])/(L_rx[k]−L_rx[k-1])`.

공통 기준점 TxDone↔RxDone(둘 다 패킷 끝) → 차이 = 전파(ns)+디코드 지연 → **T_air_ref 작고 결정론적**, 1회 캘리브레이션. 대안(양방향 NTP식): 노드 요청→마스터 T2/T3 회신, 단일 교환에 offset+왕복지연, airtime↑.

### 2.6 패킷 (리틀엔디언, 고정 길이)
```
BEACON  : type=0x01, set_id, seq, m_tx_prev(8), period, CRC16
EVENT   : type=0x02, set_id, node_id, ev_seq(2), ev_master_t(8), flags, CRC16
ID_SETUP: type=0x10(req)/0x11(cfg), set_id, node_id, channel, sf/bw, period, T_air_ref(8), sync, CRC16
```
EVENT의 ev_master_t = 노드가 미리 변환한 마스터 시각 → 마스터는 기록만.

### 2.7 재동기 주기
표준 크리스털(상대 ~40ppm), 예산 1ms → **15~25s** (주기 = 예산µs ÷ 상대ppm). 비콘 주기 = 노드 sync 주기, beacon period 필드로 통지. TCXO/skew 보정 시 수 분까지(현 예산 불필요).

### 2.8 충돌 처리
- 세트 간: 채널 분리로 없음.
- 세트 내(마스터+센서2): 노드 **TX 전 CAD**(listen-before-talk)로 비콘·상대 센서 회피. 이벤트 중요 시 **마스터 ACK + 노드 재전송**(백오프) — 시각 보존돼 재전송해도 정확.
- **우선순위: 이벤트 TX > sync RX.**

### 2.9 캘리브레이션 (T_air_ref)
고정 길이 → airtime 결정론. T_air_ref = TxDone↔RxDone 고정지연(전파 ns 무시 + 디코드/처리). 근거리 공통기준으로 1회 측정 후 ID_SETUP에 저장.

---

## 3. 핵심 하드웨어 결정

| 결정 | 내용 |
|---|---|
| MCU | **nice!nano v2** (nRF52840). 크리스털·DEC·DCC·USB-CC·3.3V LDO·Li-ion 충전기 전부 모듈 내장 |
| 라디오 | **Ra-01SH** (SX1262), u.FL 안테나. 클럭/매칭/RF스위치 내장 |
| 보드 구성 | **단일 PCB · 2개 어셈블리 변종.** 센서노드 = 풀 실장, 마스터노드 = nice!nano + Ra-01SH + 디커플링만 (나머지 DNP) |
| 전원(센서) | 보호 18650 → nice!nano 배터리 패드(온보드 충전+LDO). 12V는 외부 부스트만 추가 |
| 전원(마스터) | nice!nano USB-C 급전. 외부 전원부 없음 |
| 외부 LDO/USB커넥터/CC저항 | 모듈 내장과 **중복 → 삭제** |

### nice!nano v2 패드 ↔ nRF52840 (정본)

**총 29 패드 = 가장자리 24 + 가운데(inner) 3 + 배터리 2.**

가장자리(1–24):
```
pad 1  P0.06 (TX0)   pad 7  P0.22         pad 13 P0.09 (NFC1)  pad 19 P0.29 (AIN5)
pad 2  P0.08 (RX1)   pad 8  P0.24         pad 14 P0.10 (NFC2)  pad 20 P0.31 (AIN7)
pad 3  GND           pad 9  P1.00         pad 15 P1.11         pad 21 VCC (스위치드: P0.13=EXT_POWER 게이트)
pad 4  GND           pad 10 P0.11         pad 16 P1.13         pad 22 RST
pad 5  P0.17         pad 11 P1.04         pad 17 P1.15         pad 23 GND
pad 6  P0.20         pad 12 P1.06         pad 18 P0.02 (AIN0)  pad 24 P0.04 (BATIN)
```
가운데(inner) 3: **P1.01 · P1.02 · P1.07** (여분 GPIO, 본 설계 미사용)
배터리 2: **B+ · B-** (18650/LiPo 솔더 패드 — 온보드 충전기 경유, 과방전 보호는 셀 내장)

**예약/사용 금지**: P0.13(EXT_POWER 게이트, 미인출) · P0.15(미인출) · P0.04(배터리, BATIN 패드) ·
P0.18(RESET) · P0.00/01(크리스털) · 온보드 QSPI 플래시 핀. NFC(P0.09/0.10)는 의도적으로 미사용 → 펌웨어 NFC 비활성화 불필요.

### Ra-01SH 핀아웃 (정본, SMD16/ESP-12)

```
1 ANT    2 GND   3 3.3V  4 RESET  5 TXEN   6 DIO1   7 DIO2   8 DIO3
9 GND   10 BUSY  11 RXEN  12 SCK   13 MISO  14 MOSI  15 NSS   16 GND
```

- **TXEN(5)·RXEN(11) = RF T/R 스위치 제어**. Ai-Thinker 응용회로가 둘 다 MCU GPIO로 인출 → **반드시 구동**(RadioLib `setRfSwitchPins`). 미연결 시 TX/RX 경로 불확실.
- **DIO3(8) = 내부 TCXO 전원 제어** → 외부 N/C, 펌웨어 `begin(..., tcxoVoltage)`.
- DIO2(7) = 예비(외부 스위치 제어라 미사용). 유연성 위해 GPIO로 빼둘 수도 있음.
- IO 레벨 3.3V(nice!nano와 동일 → 레벨시프트 불요). 모듈간 배선 짧아 직렬 종단(Rs) 생략.
- ANT(1): **모듈 u.FL 커넥터에 안테나 직결** → 외부 정합 불요, 캐리어 PCB RF 미배선, ANT 패드 N/C.

---

## 4. 핀 배정 (정본 — 센서·마스터 공통)

캡처 임계 신호(DIO1, SENSOR)는 **port 0**에 배치 → 레지스터 레벨 GPIOTE PSEL 코드(`PIN<<PSEL_Pos`)가 그대로 동작. SPI 3선은 인접 패드(5·6·7)로 묶음.

| 신호 | nice!nano 패드 | nRF52840 | 포트 | 용도 |
|---|---|---|---|---|
| LoRa SCK | 5 | P0.17 | 0 | SPIM (커스텀 SPI 인스턴스) |
| LoRa MOSI | 6 | P0.20 | 0 | SPIM |
| LoRa MISO | 7 | P0.22 | 0 | SPIM |
| LoRa NSS | 8 | P0.24 | 0 | GPIO CS |
| LoRa BUSY | 9 | P1.00 | 1 | GPIO in |
| **LoRa DIO1** | 10 | **P0.11** | 0 | **GPIOTE→PPI→TIMER 캡처** (Tx/RxDone) |
| LoRa NRST | 11 | P1.04 | 1 | GPIO out |
| LoRa TXEN | 12 | P1.06 | 1 | RF 스위치 TX en |
| LoRa RXEN | 15 | P1.11 | 1 | RF 스위치 RX en |
| (DIO2 예비) | 16 | P1.13 | 1 | 선택 — 미사용 시 N/C |
| **SENSOR IN** | 1 | **P0.06** | 0 | **GPIOTE 캡처** (falling). *센서노드 전용, 마스터 미연결* |
| EXT_POWER | (pad 21 VCC 게이트) | P0.13 | 0 | VCC 스위치 — 부팅 시 HIGH (§8) |

---

## 5. 전원 아키텍처

### 5.1 센서노드
```
보호 18650 ─┬─→ nice!nano B+ (온보드 충전기+LDO → VCC 3V3, 스위치드)
            └─→ TPS61040 부스트 ─[L1/D1, R1·R2]─ 12V ─[Cout]─→ J1(V+) BA2M-DDT
nice!nano VCC(3V3, EXT_POWER로 enable) ─[100nF+10µF]─→ Ra-01SH VCC
nice!nano VCC ─→ R3(4.7k 풀업) / 센서 프런트엔드
```
- nice!nano 내장 LDO가 3.3V 담당 → 외부 LDO 삭제.
- 12V 부스트 입력 = **배터리 직결**(3.0–4.2V → TPS61040 입력 1.8–6V 범위 내).
- **보호 18650 사용**: nice!nano는 충전만, 과방전/단락 보호는 **보호셀**이 담당. 보드에 보호 IC·퓨즈 불요.
- 노이즈 격리: 라디오는 깨끗한 LDO 출력 + 디커플 캡으로 충분 → 페라이트 생략(RX 감도 이슈 시 풋프린트 예약 후 추가).
- 부스트 출력 = 1.233V × (1+1M/110k) = **12.4V** (센서 12–24V 범위 내; R1/R2 모두 Basic/Pref).

### 5.2 마스터노드
```
USB-C(nice!nano 온보드) → 온보드 LDO → VCC(3V3, EXT_POWER로 enable) ─[100nF+10µF]─→ Ra-01SH VCC
USB CDC Serial → PC (set_id 태그 스트림)
```
- 외부 전원부 **전무**. 부스트·센서·배터리 DNP.

---

## 6. 넷리스트 (KiCad 전사용)

기호: `A1`=nice!nano v2, `U1`=Ra-01SH. 모듈은 핀헤더 풋프린트(2.54mm 2열) 또는 캐스털레이션.

### 6.1 공통 (센서·마스터 양쪽 실장)
```
RA_VCC    : A1.pad21(VCC,스위치드) ─ U1.3(3V3); C_dec1(100nF→GND); C_dec2(10µF→GND)
GND       : A1.pad3/4/23, U1.2/9/16(GND), 모든 GND
SPI_SCK   : A1.pad5(P0.17)  ─ U1.12(SCK)
SPI_MOSI  : A1.pad6(P0.20)  ─ U1.14(MOSI)
SPI_MISO  : A1.pad7(P0.22)  ─ U1.13(MISO)
LORA_NSS  : A1.pad8(P0.24)  ─ U1.15(NSS)
LORA_BUSY : A1.pad9(P1.00)  ─ U1.10(BUSY)
LORA_DIO1 : A1.pad10(P0.11) ─ U1.6(DIO1)        (캡처 IRQ)
LORA_NRST : A1.pad11(P1.04) ─ U1.4(RESET)
LORA_TXEN : A1.pad12(P1.06) ─ U1.5(TXEN)        (RF 스위치 TX en)
LORA_RXEN : A1.pad15(P1.11) ─ U1.11(RXEN)       (RF 스위치 RX en)
DIO2      : U1.7  → N/C (또는 A1.pad16/P1.13로 예비 인출)
DIO3      : U1.8  → N/C (내부 TCXO 전원 제어 — 펌웨어 tcxoVoltage)
ANT       : U1 모듈 자체 u.FL 커넥터에 안테나 직결. 캐리어 PCB RF 미배선. U1.1(ANT 패드) N/C.
   디지털선 전부 직결 — 모듈간 배선이 짧아 직렬 종단(Rs) 불요.
```

### 6.2 센서노드 추가 (마스터는 전부 DNP)
```
배터리:
  BT1(+) [보호 18650] ─ NET:VBAT ;  BT1(-) ─ GND
  VBAT ─ A1.B+(배터리 패드)

12V 부스트 (TPS61040, U2 / SOT-23-5: 1=SW 2=GND 3=FB 4=EN 5=VIN):
  VBAT ─ Cin(10µF/16V→GND)               (벌크 입력캡)
  VBAT ─ L1(22µH) ─ U2.SW                (인덕터: 입력→SW, 보유분 220)
  VBAT ─ U2.VIN ;  VBAT ─ U2.EN          (상시 ON)
  U2.SW ─ D1(B5819W) ─ NET:+12V          (SW→다이오드→출력)
  +12V ─ Cout(10µF/25V→GND)
  +12V ─ R1(1M) ─ U2.FB ─ R2(110k) ─ GND   (분압 → 12.4V)

센서 프런트엔드 (BA2M-DDT, NPN OC):
  J1.V+  ─ +12V
  J1.GND ─ GND
  J1.OUT ─ R4(330Ω) ─ NET:SENSE  (C11 100nF 옵션)
  SENSE  ─ R3(4.7k) ─ 3V3        (풀업)
  SENSE  ─ D2(BAT54S: →3V3 / →GND 클램프)
  SENSE  ─ C9(100pF→GND, 옵션)
  SENSE  ─ A1.pad1(P0.06)
```
NPN OC: 평소 풀업으로 H, 검출 시 GND 싱크 → **falling 캡처**. SENSE 최대전압 = 3.3V. R4+BAT54S가 2m 케이블 트랜지언트로부터 P0.06 보호.

---

## 7. BOM

LCSC#·분류는 JLCPCB API 직접 조회(`preferredComponentFlag`). **Basic·Preferred = 셋업 수수료 없음**, **Extended = 고유부품당 1회 수수료**.

### 7.1 센서노드
| Ref | 부품 | MPN/값 | 패키지 | LCSC# · JLC | 비고 |
|---|---|---|---|---|---|
| A1 | MCU 모듈 | nice!nano v2 (nRF52840) | 모듈(2×12) | 별도조달 | SMT 라이브러리 아님 |
| U1 | LoRa 모듈 | Ra-01SH (SX1262) | 모듈 | 별도조달 | u.FL |
| U2 | 부스트 IC | TPS61040DBVR | SOT-23-5 | C7722 · **Preferred(무료)** | 12V PFM |
| L1 | 파워인덕터 | 22µH (220 마킹, 보유분) | 보유품 풋프린트 | **자가실장 · 수수료 0** | Isat≥0.5A 확인; 2.2–47µH 범위 내 |
| D1 | 쇼트키 | B5819W (1A/40V) | SOD-123 | C8598 · **Basic(무료)** | 부스트 정류(MBR0520 대체) |
| R1 | 저항 | 1MΩ 1% | 0603 | C22935 · **Basic(무료)** | 부스트 FB top |
| R2 | 저항 | 110kΩ 1% | 0603 | C25805 · **Preferred(무료)** | 부스트 FB bottom(→12.4V) |
| R3 | 저항 | 4.7kΩ | 0603 | Basic(무료) | 센서 풀업 |
| R4 | 저항 | 330Ω | 0603 | Basic(무료) | 센서 직렬 |
| D2 | 듀얼 쇼트키 | BAT54S | SOT-23 | C7420333 · **Preferred(무료)** | 센서 클램프(공급사 주의: C2828465=Extended) |
| C9 | 캡(옵션) | 100pF C0G | 0603 | Basic(무료) | 센서 핀 바이패스 |
| C11 | 캡(옵션) | 100nF | 0603 | Basic(무료) | 센서 커넥터 바이패스(C9와 π) |
| C(Ra) | 캡 | 100nF + 10µF | 0603/0805 | Basic(무료) | Ra VCC 디커플 |
| C(boost) | 캡 | Cin 10µF/16V · Cout 10µF/25V | 0805 X5R | Basic(무료) | 부스트 입·출력 |
| J1 | 커넥터 | 3P 터미널 / JST-XH B3B-XH | THT | (THT) | BA2M V+/GND/OUT |
| BT1 | 배터리 | 보호 18650 + 홀더 | THT | off-board | 보호셀 내장 |
| ANT | 안테나 | u.FL→SMA + 920MHz 휩 | RG178 | off-board | ~2dBi |
| SENSOR | 센서 | Autonics BA2M-DDT | — | off-board | 12V NPN OC 1ms |

> **JLC 수수료 요약**: 보드 SMT 전부 Basic/Preferred(무료), L1(22µH)은 보유분 자가 실장 → **JLC 셋업 수수료 전혀 없음.**

### 7.2 마스터노드 (센서노드 PCB에서 부분 실장)
| Ref | 부품 | 비고 |
|---|---|---|
| A1 | nice!nano v2 | USB-C 급전·USB CDC 출력 |
| U1 | Ra-01SH | |
| C(Ra) | 100nF + 10µF | Ra VCC 디커플 |
| ANT | u.FL→SMA + 휩 | |
| 그 외 (U2/L1/D1/R1/R2/R3/R4/D2/J1/BT1…) | **DNP** | |

---

## 8. 펌웨어

센서/마스터 펌웨어 핵심 사양 (Arduino + RadioLib + nRF52840 레지스터 캡처). 아래 서술대로 구현:

- **타임스탬프 캡처**: TIMER1 자유진행 16MHz = 공통 타임베이스. 센서 엣지 → GPIOTE→PPI→TIMER CAPTURE, DIO1(Tx/RxDone) → GPIOTE→PPI→CAPTURE. CPU 무관 HW 래치(이벤트 손실 0). DIO1·SENSOR는 **port0**이라 PSEL 코드 무수정 → `PIN_LORA_DIO1=11`, `PIN_SENSOR=6`.
- **동기 알고리즘**: §2.5의 offset 계산. `to_master_time(local)`로 이벤트 local tick → 마스터 시각 변환 후 EVENT 송신.
- **라디오/SPI**: RadioLib SX1262. nice!nano 기본 SPI 핀이 아니므로 **커스텀 `SPIClass`**(SCK P0.17 / MOSI P0.20 / MISO P0.22). `Module(NSS,DIO1,NRST,BUSY)`의 핀번호는 코어 Arduino Dxx로 변환. **`radio.setRfSwitchPins(RXEN, TXEN)` 필수**(안 하면 TX/RX 경로 안 열림). `radio.begin(freq,bw,sf,cr,sync,power,preamble,tcxoVoltage)` — Ra-01SH 내부 TCXO 위해 tcxoVoltage 지정.
- **전원**: **부팅 시 EXT_POWER(P0.13) HIGH** — 안 하면 Ra-01SH(스위치드 VCC)가 무전원.
- **NFC**: P0.09/0.10 미사용이라 NFC 비활성화 불요.
- **마스터 출력**: USB CDC Serial, `SET=%c node=%u seq=%u t=%llu` 형식으로 set_id 태그 출력.

---

## 9. 멀티세트 운용

- 각 세트 = 전용 채널(§2.2) + 자기 타임베이스. ID_SETUP으로 set_id·channel·sync 배정. 센서 부팅 시 `setFrequency(채널)` 적용.
- PC: 마스터당 USB 시리얼 1개씩 2~3 스트림 수집, **set_id 태그**로 정렬:
  ```
  SET=A node=1 seq=12 t=123456789
  SET=B node=2 seq=7  t=987654321
  ```
- 세트 내 센서1 vs 센서2 = 같은 마스터 tick이라 정밀. 세트 간은 비교 안 함.

---

## 10. 검증·확인 (Open items)

- [ ] nice!nano v2 온보드 LDO 전류 헤드룸 — Ra-01SH TX ~22mA@+10dBm, +14dBm <~60mA, RX ~4.6mA. LDO(~300mA급)로 충분(판매페이지 "피크 1A↑"는 과장). 실측 확인.
- [ ] **TXEN/RXEN**: reference는 GPIO 2선 구동(setRfSwitchPins 기본). 일부 라이브러리는 N/C 동작 보고 — 실제 모듈 확인.
- [ ] nice!nano 충전 전류(기본 낮음) vs 18650 3000mAh — 느릴 수 있음. 필요 시 외부 충전.
- [ ] Ra-01SH 스위치드 VCC → EXT_POWER enable 시 인러시 / 기본 상태 확인.
- [ ] BA2M-DDT 정확 모델 최소 동작전압(BA 시리즈 12–24V) — 12V 하한 데이터시트 확인.
- [ ] u.FL 내구(≈30회 체결) — 피그테일 상시 연결 운용.
- [ ] (선택) RX 감도 이슈 시 — 라디오 전원·부스트 입력 페라이트, 센서 케이블 클램프 페라이트 사후 추가.
- [ ] 부스트 PFM 안정성 실측 — 불안정 시 고정주파수(TPS61170급)로 교체.
- [ ] T_air_ref 실측(§2.9) — 근거리 TxDone↔RxDone 1회 캘리브레이션.

---

## 11. 다음 단계 — KiCad

이 넷리스트로 KiCad 9 GUI에서 작도. 기존 `traffic/device/hardware/`(`fsk-traffic.*`, KiCad 9)의 심볼/풋프린트·워크플로 재사용.

## 12. 범위 밖

PC측 수집/분석 SW(시리얼 파싱·set_id별 정렬·저장), KiCad 심볼/풋프린트 lib_id 실제 매핑, 기구/방수(센서 IP64·노드 인클로저)·안테나 마운트, T_air_ref 실측 절차, 인증(KC 등), 세트 간 절대시각 정렬(현재 불필요).
