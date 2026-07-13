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

    # A core-node death must tear the whole launch down so the container
    # exits and pilot.service's Restart=on-failure recreates the stack.
    # Without this, e.g. gps_node re-raising after its _open_serial retries
    # are exhausted just leaves that one process dead while the other nodes
    # keep the container 'running' — the systemd Restart never fires and the
    # rover sits with no GPS (or no MCU link) indefinitely. gps and mcu_bridge
    # are the two nodes whose hardware link is load-bearing; if either dies the
    # mission cannot run, so shut down and let the restart bring everything up
    # clean. (spray/navigator/bridge are intentionally NOT gated — they can be
    # restarted in place by ros2 without a full container bounce.)
    gps_exit_shutdown = RegisterEventHandler(
        OnProcessExit(
            target_action=gps_node,
            on_exit=[Shutdown(reason='gps_node exited')],
        )
    )
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
        gps_exit_shutdown,
        mcu_bridge_exit_shutdown,
    ])
