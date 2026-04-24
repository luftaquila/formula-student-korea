"""Launch file for the FSK Rover system.

Starts all 5 nodes: gps, motor, spray, navigator, bridge.

Secrets (INTERNAL_SECRET, NTRIP credentials) are read from the environment only.
They must never appear on the ros2 param tree or in argv, since any process on the
same ROS domain can query ros2 param tree.
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    pkg_share = get_package_share_directory('pilot')
    default_config = os.path.join(pkg_share, 'config', 'rover_params.yaml')

    # Launch arguments
    config_arg = DeclareLaunchArgument(
        'config_file',
        default_value=default_config,
        description='Path to rover_params.yaml',
    )

    server_url_arg = DeclareLaunchArgument(
        'server_url',
        default_value='',
        description='Course server URL',
    )

    config_file = LaunchConfiguration('config_file')

    # NTRIP caster host/port/password are hard-coded in gps_node (NGII only).
    # The only env var overlaid onto the ROS param tree is NTRIP_USERNAME,
    # set via `sudo snap set fsk-rover-pilot ntrip-username=...`. Mountpoint
    # is auto-selected by gps_node against the caster's source table.
    ntrip_overrides = {}
    if os.environ.get('NTRIP_USERNAME'):
        ntrip_overrides['ntrip.username'] = os.environ['NTRIP_USERNAME']

    # GPS node (start first - needs time for RTK convergence)
    gps_node = Node(
        package='pilot',
        executable='gps_node',
        name='gps_node',
        parameters=[config_file, ntrip_overrides] if ntrip_overrides else [config_file],
        output='screen',
    )

    # Motor node
    motor_node = Node(
        package='pilot',
        executable='motor_node',
        name='motor_node',
        parameters=[config_file],
        output='screen',
    )

    # Spray node
    spray_node = Node(
        package='pilot',
        executable='spray_node',
        name='spray_node',
        parameters=[config_file],
        output='screen',
    )

    # Battery node
    battery_node = Node(
        package='pilot',
        executable='battery_node',
        name='battery_node',
        parameters=[config_file],
        output='screen',
    )

    # Navigator node
    navigator_node = Node(
        package='pilot',
        executable='navigator_node',
        name='navigator_node',
        parameters=[config_file],
        output='screen',
    )

    # Bridge node (start last - connects to server once other nodes are ready).
    # INTERNAL_SECRET is pulled from env inside bridge_node to keep it off the
    # ros2 param tree; we only pass server_url through LaunchConfiguration.
    bridge_node = Node(
        package='pilot',
        executable='bridge_node',
        name='bridge_node',
        parameters=[
            config_file,
            {'server_url': LaunchConfiguration('server_url')},
        ],
        output='screen',
    )

    return LaunchDescription([
        config_arg,
        server_url_arg,
        gps_node,
        motor_node,
        spray_node,
        battery_node,
        navigator_node,
        bridge_node,
    ])
