"""Format /health JSON (stdin) for `bin/herald-voice status`. Stdlib only.

Env: PID, OWNER (port owner pid), CPU, RSS, PORT. Exit 0 only when every engine
is ready and the service PID owns the port.
"""

import json
import os
import sys


def main() -> int:
    d = json.load(sys.stdin)
    env = os.environ
    ok = all(d[k]["ready"] for k in ("tts", "stt", "wake")) and env.get("OWNER") == env.get("PID")
    head = "Voice service HEALTHY" if ok else "Voice service DEGRADED"
    print(f"{head}: PID {env.get('PID')} on 127.0.0.1:{env.get('PORT')} (cpu {env.get('CPU')}%, rss {env.get('RSS')})")
    for k in ("tts", "stt", "wake"):
        e = d[k]
        state = "ready" if e["ready"] else ("loading" if e.get("loading") else "down")
        extra = ""
        if k == "tts" and e["ready"]:
            extra = f" default voice {e['defaultVoice']}, {len(e['voices'])} voices"
        elif k == "stt":
            extra = f" model {e['model']}"
        elif k == "wake":
            extra = f" models {','.join(e['models'])} threshold {e['threshold']}"
        err = f"  error: {e['error']}" if e.get("error") else ""
        print(f"  {k}: {state}{extra}{err}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
