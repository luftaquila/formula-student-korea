from setuptools import find_packages, setup
import os
from glob import glob

package_name = 'pilot'

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
    install_requires=[
        'setuptools',
        'pyserial>=3.5',
        'requests>=2.31',
        'lgpio>=0.2.2.0',
    ],
    zip_safe=True,
    maintainer='luftaquila',
    maintainer_email='luftaquila@luftaquila.io',
    description='Formula Student Korea course rover - RTK GPS waypoint navigation with spray marking',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'battery_node = pilot.battery_node:main',
            'bridge_node = pilot.bridge_node:main',
            'gps_node = pilot.gps_node:main',
            'motor_node = pilot.motor_node:main',
            'navigator_node = pilot.navigator_node:main',
            'spray_node = pilot.spray_node:main',
        ],
    },
)
