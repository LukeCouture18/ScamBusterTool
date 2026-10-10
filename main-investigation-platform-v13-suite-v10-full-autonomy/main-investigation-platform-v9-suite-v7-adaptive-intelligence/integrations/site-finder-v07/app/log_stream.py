"""
A logging.Handler that republishes every log record emitted anywhere in the
app (navigator, ranker, pipeline, form_filler, etc.) to the live event bus,
so the UI's activity panel shows real log output as it happens rather than a
separately-maintained "UI log" that could drift from what's actually going on.
"""
import logging

from app.events import publish

LEVEL_TO_UI = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warning",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


class UIStreamHandler(logging.Handler):
    def emit(self, record: logging.LogRecord):
        try:
            msg = self.format(record)
            publish("log", {
                "level": LEVEL_TO_UI.get(record.levelno, "info"),
                "logger": record.name,
                "message": msg,
            })
        except Exception:
            # Never let a logging/formatting problem crash the app or the scan.
            pass


_installed = False


def install_ui_log_handler(logger_name: str = "scamhunter"):
    """
    Attaches the UI stream handler to the 'scamhunter' logger namespace (the
    root namespace used by every module's `logging.getLogger("scamhunter.xxx")`
    call), so one call here covers the whole app's log output. Safe to call
    more than once — only installs itself the first time.
    """
    global _installed
    if _installed:
        return
    handler = UIStreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s",
                                            datefmt="%H:%M:%S"))
    logging.getLogger(logger_name).addHandler(handler)
    _installed = True
