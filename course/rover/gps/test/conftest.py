import os
import sys

# Repo layout: this agent at course/rover/gps/, the reused pilot package at
# the sibling course/rover/pilot/. Put both roots on sys.path so the tests
# can `import gps_register` and `import pilot.lib.*` in any order. (At
# runtime on the Pi, gps_register.py's own shim handles the deploy layout.)
_GPS = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
_PILOT = os.path.abspath(os.path.join(_GPS, os.pardir, "pilot"))
for _p in (_GPS, _PILOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)
