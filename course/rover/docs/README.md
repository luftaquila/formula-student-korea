# Pilot — Course Cone Marking Robot

Raspberry Pi 5 기반 ROS2 로버. RTK GPS로 cm 단위 정밀 웨이포인트 내비게이션을 수행하고, 각 지점에서 스프레이를 뿌린다.

## Hardware

| 부품 | 모델 | 인터페이스 |
|------|------|-----------|
| 컴퓨트 | Raspberry Pi 5 | — |
| GPS | u-blox ZED-F9P | USB serial |
| RTK 보정 | NTRIP caster | Network |
| 모터 드라이버 | Cytron MDD10A | GPIO PWM+DIR |
| 구동 모터 | MD36L × 2 | 후륜구동 |
| 조향 서보 | S20F | GPIO PWM |
| 스프레이 서보 | (표준 RC 서보) | GPIO PWM |
| 플랫폼 | Wheeltec R550 (AKM) Plus | 애커먼 조향 |

## Prerequisites

- ROS2 Jazzy (`/opt/ros/jazzy/setup.bash`)
- Python 3.10+
- GPIO 접근 권한 (`dialout`, `gpio` 그룹)

## Setup

```bash
# 1. 워크스페이스 생성
mkdir -p ~/pilot_ws/src
ln -s $(pwd)/pilot ~/pilot_ws/src/pilot

# 2. 의존성 설치
pip install -r pilot/requirements.txt

# 3. 빌드
cd ~/pilot_ws
source /opt/ros/jazzy/setup.bash
colcon build --packages-select pilot
source install/setup.bash

# 4. udev 규칙 (선택)
sudo bash pilot/scripts/setup_udev.sh

# 5. 설정 편집
# pilot/config/rover_params.yaml에서 GPIO 핀, NTRIP 인증, 서버 URL, required_fix_status 등 수정
```

## Usage

```bash
# 전체 시스템 실행 — 시크릿은 환경변수로 주입 (ros2 param tree 노출 방지)
INTERNAL_SECRET=YOUR_SECRET \
NTRIP_HOST=ntrip.example.com NTRIP_PORT=2101 \
NTRIP_MOUNTPOINT=VRS-RTCM31 \
NTRIP_USERNAME=... NTRIP_PASSWORD=... \
  ros2 launch pilot pilot.launch.py \
    server_url:=https://test.luftaquila.io/course

# 개별 노드 실행 (디버그)
ros2 run pilot gps_node --ros-args --params-file pilot/config/rover_params.yaml
ros2 run pilot motor_node --ros-args --params-file pilot/config/rover_params.yaml

# 토픽 모니터링
ros2 topic echo /rover/gps/position
ros2 topic echo /rover/nav/state
ros2 topic echo /rover/gps/fix_status
```

## Ubuntu Core Snap

```bash
# snap 빌드
cd snap
snapcraft

# fsk-rover-pilot snap 설치 (production: Snap Store edge 채널)
sudo snap install fsk-rover-pilot --channel=edge

# 또는 로컬 빌드 결과 설치 (개발용)
sudo snap install --dangerous fsk-rover-pilot_*.snap

# 선택적 override
sudo snap set fsk-rover-pilot server-url=https://test.luftaquila.io/course
sudo snap set fsk-rover-pilot internal-secret=your_secret
sudo snap set fsk-rover-pilot ros-domain-id=0

# 로그 확인
snap logs fsk-rover-pilot -f
```

기본 배포 경로는 Ubuntu Core용 snap daemon이다. `pilot/config/rover_params.yaml`이 기본 설정 파일이며, 대부분의 장치는 별도 override 없이 동일한 snap으로 구동하는 것을 전제로 한다.

운영 전제는 다음과 같다.

- Ubuntu Core 이미지에는 `fsk-rover-pilot`, `tailscale` snap을 포함한다
- 최초 접속은 Ubuntu One SSH 키 주입으로 진행한다
- 첫 SSH 접속 후 운영자가 `tailscale up`과 `snap set fsk-rover-pilot ...`를 직접 수행한다
- `fsk-rover-pilot` secret은 이미지에 넣지 않고 첫 설정 시점에만 전달한다
- `snap set fsk-rover-pilot ...` 변경은 `configure` hook이 daemon 재시작으로 즉시 반영한다

## Architecture

5개의 ROS2 노드로 구성:

```
bridge_node ←── SSE/REST ──→ Course Server (port 10000)
    ↕ topics
gps_node ──→ /rover/gps/position, /heading, /fix_status
navigator_node ──→ /rover/cmd/velocity, /rover/nav/state
motor_node ←── /rover/cmd/velocity (MDD10A + S20F 서보)
spray_node ←── /rover/nav/waypoint_reached (스프레이 서보)
```

## Mission Flow

1. 웹 UI에서 "경로 실행" → 서버가 SSE `execute-path` 이벤트 전송
2. **CALIBRATING**: 직진 ~2.5m → GPS 위치 변화로 heading 계산
3. **NAVIGATING**: Pure Pursuit으로 각 웨이포인트 접근 (5cm 이내)
4. **SPRAYING**: 정지 → 서보 작동 → 스프레이 → 다음 웨이포인트
5. **RETURNING**: 마지막 웨이포인트 후 출발점 복귀

## GPIO Pin Assignment (기본값)

| 핀 | 용도 |
|----|------|
| GPIO 23 | MDD10A DIR1 (좌 모터 방향) |
| GPIO 24 | MDD10A PWM1 (좌 모터 속도) |
| GPIO 27 | MDD10A DIR2 (우 모터 방향) |
| GPIO 22 | MDD10A PWM2 (우 모터 속도) |
| GPIO 12 | S20F 조향 서보 (HW PWM ch0) |
| GPIO 13 | 스프레이 서보 (HW PWM ch1) |

## Tests

```bash
cd ~/pilot_ws
colcon test --packages-select pilot
colcon test-result --all
```
