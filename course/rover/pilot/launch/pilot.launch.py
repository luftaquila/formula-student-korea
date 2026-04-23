"""Launch file for the FSK Rover system.

Starts all 5 nodes: gps, motor, spray, navigator, bridge.
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

    internal_secret_arg = DeclareLaunchArgument(
        'internal_secret',
        default_value=os.environ.get('INTERNAL_SECRET', ''),
        description='Internal service secret for server auth',
    )

    config_file = LaunchConfiguration('config_file')

    # GPS node (start first - needs time for RTK convergence)
    gps_node = Node(
        package='pilot',
        executable='gps_node',
        name='gps_node',
        parameters=[config_file],
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

    # Navigator node
    navigator_node = Node(
        package='pilot',
        executable='navigator_node',
        name='navigator_node',
        parameters=[config_file],
        output='screen',
    )

    # Bridge node (start last - connects to server once other nodes are ready)
    bridge_node = Node(
        package='pilot',
        executable='bridge_node',
        name='bridge_node',
        parameters=[
            config_file,
            {
                'server_url': LaunchConfiguration('server_url'),
                'internal_secret': LaunchConfiguration('internal_secret'),
            },
        ],
        output='screen',
    )

    return LaunchDescription([
        config_arg,
        server_url_arg,
        internal_secret_arg,
        gps_node,
        motor_node,
        spray_node,
        navigator_node,
        bridge_node,
    ])
