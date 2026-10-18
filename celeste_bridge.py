#!/usr/bin/env python3
"""Ancien nom de la passerelle : tout est maintenant dans celeste-bridge.py (même dossier).
python celeste_bridge.py [options] lance exactement celeste-bridge.py (ancienne option « --port 8765 » = port HTTP, toujours acceptée)."""
import importlib.util, os, sys
_spec = importlib.util.spec_from_file_location('celeste_bridge_v2', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'celeste-bridge.py'))
_m = importlib.util.module_from_spec(_spec); sys.modules['celeste_bridge_v2'] = _m; _spec.loader.exec_module(_m)
globals().update({k: v for k, v in vars(_m).items() if not k.startswith('__')})
if __name__ == '__main__':
    _m.main()
