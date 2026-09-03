# `cd agent && python3 -m unittest -v` imports this package first; putting tests/ on the path lets
# every module `from helpers import …` exactly as it does when run directly (python3 tests/test_x.py).
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
