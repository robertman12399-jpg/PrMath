#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборщик «Интерактивная геометрия» в один исполняемый файл (.exe / бинарник).

Все настройки — в build.config.json, любую можно переопределить из командной строки.
Внутрь exe упаковывается и web/, и (по желанию) pywebview, поэтому конечному
пользователю НЕ нужно ставить Python или какие-либо библиотеки — просто запустить файл.

Примеры:
    python build.py                      # сборка по build.config.json
    python build.py --name МояИгра       # переопределить имя
    python build.py --onedir --console   # папкой и с консолью (для отладки)
    python build.py --icon app.ico       # со своей иконкой
    python build.py --dry-run            # только показать команду PyInstaller

Важно: PyInstaller не умеет кросс-компиляцию — .exe для Windows нужно собирать
на Windows, бинарник для macOS — на macOS, и т.д.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "build.config.json")

DEFAULTS = {
    "app_name": "GeometryApp",
    "entry": "main.py",
    "web_dir": "web",
    "icon": "",
    "onefile": True,
    "windowed": True,
    "include_pywebview": True,
    "output_dir": "build",
    "extra_data": [],            # доп. файлы/папки: ["src<sep>dest", ...] (sep подставится сам)
    "extra_pyinstaller_args": [],
    "clean": True,
}


def load_config(path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print(f"⚠ Не удалось прочитать {path}: {e}\n  Использую настройки по умолчанию.")
    return cfg


def parse_args():
    p = argparse.ArgumentParser(description="Сборка «Интерактивная геометрия» в один исполняемый файл.")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="путь к build.config.json")
    p.add_argument("--name", help="имя приложения / выходного файла")
    p.add_argument("--entry", help="точка входа (по умолчанию main.py)")
    p.add_argument("--web-dir", help="папка с веб-приложением")
    p.add_argument("--icon", help="иконка (.ico для Windows, .icns для macOS)")
    p.add_argument("--output-dir", help="куда складывать результат (по умолчанию build)")
    onef = p.add_mutually_exclusive_group()
    onef.add_argument("--onefile", action="store_true", help="один файл (по умолчанию)")
    onef.add_argument("--onedir", action="store_true", help="папка с файлами (быстрее запуск)")
    win = p.add_mutually_exclusive_group()
    win.add_argument("--windowed", action="store_true", help="без окна консоли (по умолчанию)")
    win.add_argument("--console", action="store_true", help="с консолью (для отладки)")
    p.add_argument("--no-pywebview", action="store_true", help="не вшивать pywebview")
    p.add_argument("--no-clean", action="store_true", help="не очищать перед сборкой")
    p.add_argument("--dry-run", action="store_true", help="показать команду и выйти")
    return p.parse_args()


def apply_overrides(cfg, a):
    if a.name: cfg["app_name"] = a.name
    if a.entry: cfg["entry"] = a.entry
    if a.web_dir: cfg["web_dir"] = a.web_dir
    if a.icon is not None and a.icon != "": cfg["icon"] = a.icon
    if a.output_dir: cfg["output_dir"] = a.output_dir
    if a.onefile: cfg["onefile"] = True
    if a.onedir: cfg["onefile"] = False
    if a.windowed: cfg["windowed"] = True
    if a.console: cfg["windowed"] = False
    if a.no_pywebview: cfg["include_pywebview"] = False
    if a.no_clean: cfg["clean"] = False
    return cfg


def ensure_pyinstaller(dry_run):
    try:
        import PyInstaller  # noqa: F401
        return True
    except Exception:
        msg = (
            "PyInstaller не установлен.\n"
            "  Установи зависимости для сборки:\n"
            "      pip install -r requirements.txt\n"
            "  (или вручную: pip install pyinstaller pywebview)"
        )
        if dry_run:
            print("ℹ " + msg + "\n  (--dry-run: всё равно показываю команду)\n")
            return False
        print("✗ " + msg)
        sys.exit(1)


def build_command(cfg):
    sep = os.pathsep  # ';' на Windows, ':' на остальных
    entry = os.path.join(HERE, cfg["entry"])
    out = os.path.abspath(os.path.join(HERE, cfg["output_dir"]))
    workpath = os.path.join(out, "_work")
    specpath = os.path.join(out, "_spec")

    cmd = [sys.executable, "-m", "PyInstaller", entry,
           "--name", cfg["app_name"],
           "--noconfirm",
           "--distpath", out,
           "--workpath", workpath,
           "--specpath", specpath]

    cmd.append("--onefile" if cfg.get("onefile", True) else "--onedir")
    cmd.append("--windowed" if cfg.get("windowed", True) else "--console")

    if cfg.get("clean", True):
        cmd.append("--clean")

    # web/ -> внутрь сборки как web/
    web = cfg.get("web_dir", "web")
    cmd += ["--add-data", f"{os.path.join(HERE, web)}{sep}{web}"]

    # доп. данные
    for item in cfg.get("extra_data", []):
        cmd += ["--add-data", item.replace("<sep>", sep)]

    # иконка
    icon = cfg.get("icon", "")
    if icon:
        if not os.path.isabs(icon):
            icon = os.path.join(HERE, icon)
        cmd += ["--icon", icon]

    # вшить pywebview, чтобы у пользователя было нативное окно без установки чего-либо
    if cfg.get("include_pywebview", True):
        cmd += ["--collect-all", "webview"]

    cmd += list(cfg.get("extra_pyinstaller_args", []))
    return cmd, out


def main():
    a = parse_args()
    cfg = apply_overrides(load_config(a.config), a)

    print("⚙  Настройки сборки:")
    for k in ("app_name", "entry", "web_dir", "onefile", "windowed",
              "include_pywebview", "icon", "output_dir"):
        print(f"     {k:18} = {cfg.get(k)}")
    print()

    have_pi = ensure_pyinstaller(a.dry_run)
    cmd, out = build_command(cfg)

    printable = " ".join(f'"{c}"' if " " in c else c for c in cmd)
    print("▶  Команда PyInstaller:\n   " + printable + "\n")

    if a.dry_run:
        print("ℹ  Это пробный прогон (--dry-run). Сборка не запущена.")
        return
    if not have_pi:
        return

    os.makedirs(out, exist_ok=True)
    ret = subprocess.call(cmd)
    if ret != 0:
        print("\n✗ Сборка завершилась с ошибкой (код %d)." % ret)
        sys.exit(ret)

    # где лежит результат
    name = cfg["app_name"]
    if cfg.get("onefile", True):
        exe = os.path.join(out, name + (".exe" if os.name == "nt" else ""))
    else:
        exe = os.path.join(out, name)
    print("\n✓ Готово! Результат:")
    print("   " + exe)
    print("\nЭтот файл можно отдавать пользователям как есть — Python и библиотеки не нужны.")


if __name__ == "__main__":
    main()
