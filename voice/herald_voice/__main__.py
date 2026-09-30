"""Entry point: python -m herald_voice (normally via bin/herald-voice start)."""

from __future__ import annotations

import logging
import sys

from aiohttp import web

from . import engines
from .config import load_settings
from .server import create_app


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    # aiohttp's access log would record every wake chunk; keep it quiet.
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    settings = load_settings()
    if settings.host not in ("127.0.0.1", "::1", "localhost"):
        logging.getLogger("herald_voice").warning(
            "binding %s: the voice service has no auth of its own; keep it on loopback", settings.host
        )
    app = create_app(
        settings,
        tts_loader=lambda: engines.build_tts(settings),
        stt_loader=lambda: engines.build_stt(settings),
        wake_factory=lambda: engines.build_wake(settings),
    )
    web.run_app(app, host=settings.host, port=settings.port, access_log=None, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
