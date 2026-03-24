from setuptools import find_packages, setup
import os
from glob import glob

package_name = 'fsk_rover'

setup(
    name=package_name,
    version='1.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.py')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='luftaquila',
    maintainer_email='luftaquila@luftaquila.io',
    description='Formula Student Korea course rover - RTK GPS waypoint navigation with spray marking',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'bridge_node = fsk_rover.bridge_node:main',
            'gps_node = fsk_rover.gps_node:main',
            'motor_node = fsk_rover.motor_node:main',
            'navigator_node = fsk_rover.navigator_node:main',
            'spray_node = fsk_rover.spray_node:main',
        ],
    },
)
