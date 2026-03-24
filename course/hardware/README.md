# FSK Rover — Course Cone Marking Robot

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
mkdir -p ~/fsk_rover_ws/src
ln -s $(pwd)/fsk_rover ~/fsk_rover_ws/src/fsk_rover

# 2. 의존성 설치
pip install -r requirements.txt

# 3. 빌드
cd ~/fsk_rover_ws
source /opt/ros/jazzy/setup.bash
colcon build --packages-select fsk_rover
source install/setup.bash

# 4. udev 규칙 (선택)
sudo bash fsk_rover/../scripts/setup_udev.sh

# 5. 설정 편집
# rover_params.yaml에서 GPIO 핀, NTRIP 인증, 서버 URL 등 수정
```

## Usage

```bash
# 전체 시스템 실행
ros2 launch fsk_rover rover.launch.py \
  server_url:=https://test.luftaquila.io/course \
  internal_secret:=YOUR_SECRET

# 개별 노드 실행 (디버그)
ros2 run fsk_rover gps_node --ros-args --params-file config/rover_params.yaml
ros2 run fsk_rover motor_node --ros-args --params-file config/rover_params.yaml

# 토픽 모니터링
ros2 topic echo /rover/gps/position
ros2 topic echo /rover/nav/state
ros2 topic echo /rover/gps/fix_status
```

## Systemd (자동 시작)

```bash
# 환경 변수 설정
sudo systemctl edit fsk-rover
# [Service]
# Environment="SERVER_URL=https://test.luftaquila.io/course"
# Environment="INTERNAL_SECRET=your_secret"

sudo cp scripts/systemd/fsk-rover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fsk-rover
sudo journalctl -u fsk-rover -f
```

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
cd ~/fsk_rover_ws
colcon test --packages-select fsk_rover
colcon test-result --all
```
