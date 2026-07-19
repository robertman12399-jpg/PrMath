#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Интерактивная геометрия — десктоп-обёртка.

Запуск:  python main.py

Окно открывается так (по приоритету):
  1) нативное окно через pywebview (если установлен)  -> лучший вид;
  2) окно браузера в "app"-режиме (Chrome/Edge, без рамок) -> без доп. библиотек;
  3) обычная вкладка в браузере по умолчанию.

Никаких обязательных сторонних библиотек для запуска нет — хватает обычного Python.
Для собранного .exe внутрь упаковывается pywebview (см. build.py), поэтому
конечному пользователю вообще ничего ставить не нужно.
"""

import os
import sys
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# ----------------------- Настройки окна -----------------------
APP_NAME = "Алгебра. Геометрия. Вероятность и статистика"
WIN_W, WIN_H = 1080, 800
MIN_W, MIN_H = 380, 560
HOST = "127.0.0.1"
# Фиксированный порт — чтобы сохранения в браузере (localStorage) не терялись
# между запусками: localStorage привязан к адресу страницы (включая порт), поэтому
# случайный порт при каждом старте означал бы "новый сайт" с точки зрения браузера —
# и старый прогресс становился недоступен. Порт стабилен и отличается от других
# наших приложений (геометрия использует 48831), чтобы оба могли работать
# одновременно без конфликта.
PREFERRED_PORT = 48841
PORT_FALLBACKS = [48842, 48843, 48844, 48845]
# --------------------------------------------------------------


def web_dir() -> str:
    """Папка с веб-приложением. Работает и при обычном запуске,
    и внутри собранного PyInstaller-бинарника (sys._MEIPASS)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "web")


class Handler(SimpleHTTPRequestHandler):
    """Отдаёт файлы строго из web/ и не засоряет консоль логами."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=web_dir(), **kwargs)

    def log_message(self, *args, **kwargs):  # тишина в консоли
        pass


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((HOST, 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def acquire_server() -> tuple[ThreadingHTTPServer, int]:
    """Запускает сервер на стабильном порту, чтобы сохранения браузера не терялись
    между запусками игры. Сначала пробует основной фиксированный порт, затем —
    несколько запасных фиксированных портов (на случай, если приложение уже открыто
    в другом окне), и только если заняты вообще все — берёт случайный порт,
    как раньше (тогда прогресс в этом окне будет новым, "с нуля")."""
    for port in [PREFERRED_PORT] + PORT_FALLBACKS:
        try:
            return start_server(port), port
        except OSError:
            continue
    port = free_port()
    print(
        f"Все стандартные порты ({PREFERRED_PORT}, {PORT_FALLBACKS}) заняты — "
        f"использую случайный порт {port}. Если приложение не было открыто где-то ещё, "
        "старый прогресс в этом окне может быть недоступен."
    )
    return start_server(port), port


def find_chromium() -> str | None:
    """Ищет Chrome или Edge для запуска в режиме приложения (без рамок)."""
    import shutil

    # Linux / в PATH
    for name in ("google-chrome", "google-chrome-stable", "chromium",
                 "chromium-browser", "microsoft-edge", "brave-browser"):
        found = shutil.which(name)
        if found:
            return found

    # Типичные пути на Windows и macOS
    candidates = [
        # Windows — Chrome
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        # Windows — Edge
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        # macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def open_native_window(url: str) -> bool:
    """Пытается открыть нативное окно через pywebview. True — если получилось."""
    try:
        import webview  # pip install pywebview
    except Exception:
        return False
    try:
        webview.create_window(
            APP_NAME, url, width=WIN_W, height=WIN_H, min_size=(MIN_W, MIN_H)
        )
        webview.start()  # блокирует поток, пока окно открыто
        return True
    except Exception as e:
        print("pywebview не смог открыть окно:", e)
        return False


def open_app_window(url: str) -> bool:
    """Открывает Chrome/Edge в режиме --app (окно без вкладок и адресной строки)."""
    chrome = find_chromium()
    if not chrome:
        return False
    import subprocess
    import tempfile

    profile = os.path.join(tempfile.gettempdir(), "geometry_app_profile")
    try:
        subprocess.Popen(
            [
                chrome,
                f"--app={url}",
                f"--window-size={WIN_W},{WIN_H}",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--no-default-browser-check",
            ]
        )
        return True
    except Exception:
        return False


def main():
    httpd, port = acquire_server()
    url = f"http://{HOST}:{port}/index.html"

    # 1) нативное окно (если есть pywebview) — само блокирует до закрытия
    if open_native_window(url):
        return

    # 2) окно-приложение в Chrome/Edge, либо 3) обычная вкладка
    if not open_app_window(url):
        webbrowser.open(url)

    print(f"{APP_NAME} запущено:  {url}")
    print("Чтобы выйти — закрой это окно консоли или нажми Ctrl+C.")
    try:
        threading.Event().wait()  # держим сервер живым
    except KeyboardInterrupt:
        print("\nЗавершение.")


if __name__ == "__main__":
    main()
