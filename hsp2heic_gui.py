#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HSP -> HEIC GUI / 图形界面版

Double-click the exe, pick a folder or a few .HSP photos, and the converted
.HEIC files are written into a "HEIC" sub-folder next to the source.

双击 exe，选择文件夹或几张 .HSP 照片，转换结果会写进源文件旁边的
"HEIC" 子文件夹。

The GUI is a thin front-end over hsp2heic.py; the conversion itself is the
same lossless HEVC re-wrapping.
"""

import os
import sys
import time
import queue
import threading
import traceback

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import hsp2heic as core

APP_NAME = "HSP -> HEIC"
VERSION = core.VERSION


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def human(n):
    return core.human(n)


def open_folder(path):
    try:
        os.startfile(path)  # noqa: S606 - intentional on Windows
    except Exception:
        pass


def collect_sources(paths):
    found = []
    for p in paths:
        p = os.path.abspath(p)
        if os.path.isdir(p):
            found.extend(core.find_sources([p], True))
        elif os.path.isfile(p) and p.lower().endswith(".hsp"):
            found.append(p)
    seen, uniq = set(), []
    for p in found:
        key = os.path.normcase(p)
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def convert_one(src, force):
    """Convert a single file, returning (destination, meta, size, status)."""
    out_dir = os.path.join(os.path.dirname(src), core.OUT_SUBDIR)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(src))[0]
    dst = os.path.join(out_dir, stem + core.HEIC_SUFFIX)
    meta, size, status = core.convert_file(src, dst, force)
    return dst, meta, size, status


# --------------------------------------------------------------------------
# Headless self-test (used by the build pipeline, harmless for users)
# --------------------------------------------------------------------------

def run_selftest(folder):
    folder = os.path.abspath(folder)
    sources = collect_sources([folder])
    lines = ["HSP2HEIC %s selftest" % VERSION, "folder: %s" % folder,
             "found: %d" % len(sources)]
    ok = failed = 0
    for src in sources:
        try:
            dst, meta, size, status = convert_one(src, force=True)
            ok += 1
            lines.append("OK   %s -> %s %dx%d %s" % (
                os.path.basename(src), os.path.basename(dst),
                meta["width"], meta["height"], human(size or 0)))
        except Exception as exc:
            failed += 1
            lines.append("FAIL %s: %s" % (os.path.basename(src), exc))
    lines.append("result: %d ok, %d failed" % (ok, failed))
    log = os.path.join(folder, "_selftest.txt")
    with open(log, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    sys.exit(0 if failed == 0 and ok > 0 else 1)


# --------------------------------------------------------------------------
# GUI
# --------------------------------------------------------------------------

class App:
    def __init__(self, root):
        self.root = root
        self.busy = False
        self.stop_event = threading.Event()
        self.queue = queue.Queue()
        self.out_dirs = []
        self.last_out_dir = None

        root.title("%s  v%s" % (APP_NAME, VERSION))
        root.minsize(720, 520)
        root.geometry("820x600")

        try:
            style = ttk.Style()
            style.theme_use("vista")
            base = ("Microsoft YaHei UI", 10)
            root.option_add("*Font", base)
            style.configure("Title.TLabel", font=("Microsoft YaHei UI", 16, "bold"))
            style.configure("Sub.TLabel", foreground="#555555")
            style.configure("Run.TButton", font=("Microsoft YaHei UI", 10, "bold"))
        except Exception:
            pass

        outer = ttk.Frame(root, padding=16)
        outer.pack(fill="both", expand=True)

        ttk.Label(outer, text=core.tr("HSP → HEIC  无损转换", "HSP → HEIC  lossless converter"),
                  style="Title.TLabel").pack(anchor="w")
        ttk.Label(outer,
                  text=core.tr("松下 HLG Photo 转成手机能直接看的 HDR HEIC，不重新压缩，保留 EXIF。",
                               "Panasonic HLG Photo to HDR HEIC for phones. No re-encoding, EXIF kept."),
                  style="Sub.TLabel").pack(anchor="w", pady=(2, 14))

        bar = ttk.Frame(outer)
        bar.pack(fill="x")

        self.btn_folder = ttk.Button(bar, text=core.tr("选择文件夹…", "Choose folder…"),
                                     command=self.pick_folder)
        self.btn_folder.pack(side="left")
        self.btn_files = ttk.Button(bar, text=core.tr("选择照片…", "Choose photos…"),
                                    command=self.pick_files)
        self.btn_files.pack(side="left", padx=(8, 0))

        self.force_var = tk.BooleanVar(value=False)
        self.chk_force = ttk.Checkbutton(bar, text=core.tr("覆盖已存在的 HEIC", "Overwrite existing HEIC"),
                                         variable=self.force_var)
        self.chk_force.pack(side="right")

        log_frame = ttk.Frame(outer)
        log_frame.pack(fill="both", expand=True, pady=(14, 10))

        ttk.Label(log_frame, text=core.tr("日志", "Log"), style="Sub.TLabel").pack(anchor="w", pady=(0, 4))

        log_body = ttk.Frame(log_frame)
        log_body.pack(fill="both", expand=True)

        self.text = tk.Text(log_body, height=14, wrap="none", state="disabled",
                            background="#111418", foreground="#d7dde5",
                            insertbackground="#d7dde5", relief="flat", padx=8, pady=6,
                            font=("Consolas", 9))
        scroll = ttk.Scrollbar(log_body, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        self.text.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.text.tag_configure("ok", foreground="#7ee2a8")
        self.text.tag_configure("err", foreground="#ff8a80")
        self.text.tag_configure("dim", foreground="#8b97a5")

        self.progress = ttk.Progressbar(outer, mode="determinate", maximum=100)
        self.progress.pack(fill="x")

        bottom = ttk.Frame(outer)
        bottom.pack(fill="x", pady=(8, 0))

        self.status = ttk.Label(bottom, text=core.tr("就绪", "Ready"))
        self.status.pack(side="left")

        self.btn_open = ttk.Button(bottom, text=core.tr("打开输出文件夹", "Open output folder"),
                                   command=self.open_output, state="disabled")
        self.btn_open.pack(side="right")
        self.btn_stop = ttk.Button(bottom, text=core.tr("停止", "Stop"),
                                   command=self.stop, state="disabled")
        self.btn_stop.pack(side="right", padx=(0, 8))

        self.log(core.tr("输出规则：结果放在源文件旁边的 HEIC 文件夹里。",
                         "Output rule: results go to a HEIC sub-folder next to each source."),
                 "dim")
        self.text.yview_moveto(0.0)

    # ---- logging -------------------------------------------------------
    def log(self, msg, tag=None):
        self.text.configure(state="normal")
        self.text.insert("end", msg + "\n", tag or ())
        self.text.see("end")
        self.text.configure(state="disabled")

    # ---- picking -------------------------------------------------------
    def pick_folder(self):
        if self.busy:
            return
        folder = filedialog.askdirectory(title=core.tr("选择包含 HSP 的文件夹",
                                                        "Choose a folder containing .HSP files"))
        if not folder:
            return
        sources = collect_sources([folder])
        if not sources:
            messagebox.showwarning(APP_NAME, core.tr("这个文件夹里没有找到 .HSP 文件。",
                                                     "No .HSP files found in that folder."))
            return
        self.start(sources)

    def pick_files(self):
        if self.busy:
            return
        files = filedialog.askopenfilenames(
            title=core.tr("选择 HSP 照片", "Choose .HSP photos"),
            filetypes=[(core.tr("HLG Photo", "HLG Photo"), "*.HSP;*.hsp"),
                       (core.tr("所有文件", "All files"), "*.*")])
        if not files:
            return
        sources = collect_sources(files)
        if not sources:
            messagebox.showwarning(APP_NAME, core.tr("没有选中 .HSP 文件。", "No .HSP files selected."))
            return
        self.start(sources)

    # ---- running -------------------------------------------------------
    def start(self, sources):
        self.busy = True
        self.stop_event.clear()
        self.out_dirs = []
        self.progress["value"] = 0
        self.progress["maximum"] = len(sources)
        self.btn_folder.configure(state="disabled")
        self.btn_files.configure(state="disabled")
        self.chk_force.configure(state="disabled")
        self.btn_open.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.log("", None)
        self.log(core.tr("开始转换 %d 个文件…", "Converting %d file(s)…") % len(sources), "dim")
        self.status.configure(text=core.tr("转换中…", "Converting…"))
        threading.Thread(target=self.worker, args=(sources, self.force_var.get()),
                         daemon=True).start()
        self.root.after(80, self.poll)

    def worker(self, sources, force):
        total = len(sources)
        ok = skipped = failed = 0
        total_bytes = 0
        errors = []
        for idx, src in enumerate(sources, 1):
            if self.stop_event.is_set():
                break
            name = os.path.basename(src)
            t0 = time.time()
            try:
                dst, meta, size, status = convert_one(src, force)
                ms = (time.time() - t0) * 1000
                if status == "skip":
                    skipped += 1
                    self.queue.put(("log", ("[%d/%d] %s  —  %s" % (
                        idx, total, name,
                        core.tr("跳过（已存在 HEIC）", "skipped (HEIC exists)")), "dim")))
                else:
                    ok += 1
                    total_bytes += size or 0
                    if os.path.dirname(dst) not in self.out_dirs:
                        self.out_dirs.append(os.path.dirname(dst))
                    self.last_out_dir = os.path.dirname(dst)
                    self.queue.put(("log", ("[%d/%d] %s  →  %s   %dx%d  %d-bit  %s  %.0f ms" % (
                        idx, total, name, os.path.basename(dst),
                        meta["width"], meta["height"], meta["bit_depth"],
                        human(size or 0), ms), "ok")))
            except Exception as exc:
                failed += 1
                errors.append((name, exc))
                self.queue.put(("log", ("[%d/%d] %s  —  %s: %s" % (
                    idx, total, name, core.tr("失败", "failed"), exc), "err")))
            self.queue.put(("progress", idx))
        self.queue.put(("done", {"ok": ok, "skipped": skipped, "failed": failed,
                                 "bytes": total_bytes, "errors": errors,
                                 "stopped": self.stop_event.is_set()}))

    def poll(self):
        try:
            while True:
                kind, payload = self.queue.get_nowait()
                if kind == "log":
                    msg, tag = payload
                    self.log(msg, tag)
                elif kind == "progress":
                    self.progress["value"] = payload
                elif kind == "done":
                    self.finish(payload)
                    return
        except queue.Empty:
            pass
        self.root.after(80, self.poll)

    def finish(self, res):
        self.busy = False
        self.progress["value"] = self.progress["maximum"]
        self.btn_folder.configure(state="normal")
        self.btn_files.configure(state="normal")
        self.chk_force.configure(state="normal")
        self.btn_stop.configure(state="disabled")
        if self.last_out_dir:
            self.btn_open.configure(state="normal")

        head = core.tr("完成：成功 %d，跳过 %d，失败 %d，共写出 %s",
                       "Done: %d ok, %d skipped, %d failed, %s written") % (
            res["ok"], res["skipped"], res["failed"], human(res["bytes"]))
        if res["stopped"]:
            head = core.tr("已停止。", "Stopped.") + " " + head
        self.log("", None)
        self.log(head, "ok" if not res["failed"] else "err")
        if self.last_out_dir:
            self.log(core.tr("输出目录：%s", "Output: %s") % self.last_out_dir, "dim")
        self.status.configure(text=head)

        if res["failed"] and res["errors"]:
            detail = "\n".join("%s: %s" % (n, e) for n, e in res["errors"][:8])
            messagebox.showerror(APP_NAME, head + "\n\n" + detail)
        else:
            messagebox.showinfo(APP_NAME, head + ("\n\n" + self.last_out_dir if self.last_out_dir else ""))

    def stop(self):
        self.stop_event.set()
        self.status.configure(text=core.tr("正在停止…", "Stopping…"))
        self.btn_stop.configure(state="disabled")

    def open_output(self):
        if self.last_out_dir:
            open_folder(self.last_out_dir)


def _icon_path():
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, "hsp2heic.ico")
    return path if os.path.exists(path) else None


def main():
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    root = tk.Tk()
    icon = _icon_path()
    if icon:
        try:
            root.iconbitmap(default=icon)
        except Exception:
            pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--selftest":
        run_selftest(sys.argv[2])
    try:
        main()
    except Exception:
        # Windowed builds have no console; leave a trace next to the exe.
        try:
            base = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else __file__)
            with open(os.path.join(base, "HSP2HEIC-error.log"), "w", encoding="utf-8") as f:
                f.write(traceback.format_exc())
        except Exception:
            pass
        raise
