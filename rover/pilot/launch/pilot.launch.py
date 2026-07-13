"""Launch file for the FSK Rover system.

Drive I/O (motor PWM, steering servo, encoder, battery ADC, E-Stop,
watchdog) plus the mission-specific peristaltic pump (GP6, IRLZ44N
MOSFET) all live on the RP2040 coprocessor (`rover/mcu/`); the Pi
drives no GPIO. The Pi runs five ROS 2 nodes: gps, navigator,
mcu_bridge, spray, bridge (course server).
Secrets (INTERNAL_SECRET, NTRIP credentials) come from the environment
only — never on the ROS param tree.
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, RegisterEventHandler, Shutdown
from launch.event_handlers import OnProcessExit
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    pkg_share = get_package_share_directory('pilot')
    default_config = os.path.join(pkg_share, 'config', 'rover_params.yaml')

    config_arg = DeclareLaunchArgument(
        'config_file', default_value=default_config,
        description='Path to rover_params.yaml',
    )
    server_url_arg = DeclareLaunchArgument(
        'server_url', default_value='',
        description='Course server URL',
    )

    config_file = LaunchConfiguration('config_file')

    ntrip_overrides = {}
    if os.environ.get('NTRIP_USERNAME'):
        ntrip_overrides['ntrip.username'] = os.environ['NTRIP_USERNAME']

    gps_node = Node(
        package='pilot', executable='gps_node', name='gps_node',
        parameters=[config_file, ntrip_overrides] if ntrip_overrides else [config_file],
        output='screen',
    )

    mcu_bridge_node = Node(
        package='pilot', executable='mcu_bridge_node', name='mcu_bridge_node',
        parameters=[config_file], output='screen',
    )

    spray_node = Node(
        package='pilot', executable='spray_node', name='spray_node',
        parameters=[config_file], output='screen',
    )

    navigator_node = Node(
        package='pilot', executable='navigator_node', name='navigator_node',
        parameters=[config_file], output='screen',
    )

    bridge_node = Node(
        package='pilot', executable='bridge_node', name='bridge_node',
        parameters=[config_file, {'server_url': LaunchConfiguration('server_url')}],
        output='screen',
    )

    # The MCU link is load-bearing for ANY operation: without the RP2040 there
    # is no motor PWM, steering, E-Stop or watchdog, so manual teleop can't run
    # either. If mcu_bridge_node dies, tear the whole launch down so the
    # container exits and pilot.service's Restart=on-failure recreates the stack
    # clean. (spray/navigator/bridge are NOT gated — ros2 can restart them in
    # place without a full container bounce.)
    #
    # gps_node is deliberately NOT gated: a missing or lost GPS (or camera) must
    # never tear down the stack, because manual control needs neither. gps_node
    # starts non-fatally when no receiver is present and its _read_serial timer
    # keeps retrying the reopen (indefinite, backed-off recovery), so it
    # self-heals when the F9P is plugged in — all while manual control stays
    # live. Autonomous missions remain safe: navigator won't drive without a
    # gps fix meeting required_fix_status (rtk_fixed) within gps_timeout.
    mcu_bridge_exit_shutdown = RegisterEventHandler(
        OnProcessExit(
            target_action=mcu_bridge_node,
            on_exit=[Shutdown(reason='mcu_bridge_node exited')],
        )
    )

    return LaunchDescription([
        config_arg,
        server_url_arg,
        gps_node,
        mcu_bridge_node,
        spray_node,
        navigator_node,
        bridge_node,
        mcu_bridge_exit_shutdown,
    ])
