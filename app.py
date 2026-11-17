"""DriveReady desktop launcher.

Serves the game files from a private local web server and shows them in a
native window (pywebview). If no native web view is available it falls back
to the default browser. Build a Windows .exe with build_exe.bat.
"""
import functools
import http.server
import os
import sys
import threading
import webbrowser

TITLE = "DriveReady - Driving School Simulator"


class Api:
    """Methods the game page can call as window.pywebview.api.<name>()."""

    def __init__(self, fb):
        self._fb = fb

    def ffb_info(self):
        return self._fb.info() if self._fb else {"available": False, "status": "not supported", "device": ""}

    def ffb(self, values):
        if self._fb:
            self._fb.set(values)


def resource_dir():
    # PyInstaller unpacks bundled files to sys._MEIPASS at runtime.
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # a windowed .exe has no console to log to
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=resource_dir())
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_in_browser(url):
    webbrowser.open(url)
    try:
        import tkinter as tk
    except Exception:
        threading.Event().wait()  # no GUI toolkit: keep serving until killed
        return
    root = tk.Tk()
    root.title(TITLE)
    tk.Label(root, padx=24, pady=16, justify="left",
             text="DriveReady is running in your web browser.\n\n"
                  f"{url}\n\nClose this window to quit.").pack()
    tk.Button(root, text="Open again", command=lambda: webbrowser.open(url)).pack(pady=(0, 16))
    root.mainloop()


def main():
    server = start_server()
    url = f"http://127.0.0.1:{server.server_port}/index.html"
    try:
        import webview
    except Exception:
        run_in_browser(url)
        server.shutdown()
        return
    try:
        from ffb import ForceFeedback
        fb = ForceFeedback()
    except Exception:
        fb = None   # force feedback is optional; the game runs without it
    webview.create_window(TITLE, url, width=1280, height=800, min_size=(900, 600), js_api=Api(fb))
    webview.start()
    if fb:
        fb.stop()   # stop the wheel's motor before exiting
    server.shutdown()


if __name__ == "__main__":
    main()
