# Building the Windows exe

The GUI is `hsp2heic_gui.py`, a Tkinter front-end over `hsp2heic.py`. The release exe is a
PyInstaller one-file build.

## Requirements

- Python 3.9–3.13 with Tkinter (the official python.org installer includes it)
- PyInstaller 6.x

```bat
py -3 -m pip install --upgrade pyinstaller
```

## Build

From the repository root:

```bat
py -3 -m PyInstaller --noconfirm --clean --onefile --windowed ^
    --name HSP2HEIC ^
    --icon hsp2heic.ico ^
    --add-data "hsp2heic.ico;." ^
    hsp2heic_gui.py
```

The result is `dist\HSP2HEIC.exe` (about 11 MB). The icon is embedded both as the exe icon
and as the window icon (loaded from the bundle at runtime).

## Portable zip

The portable build is just the embeddable Python distribution plus the CLI:

```
HSP2HEIC-portable\
├─ convert.bat
├─ hsp2heic.py
├─ 使用说明.txt
├─ raw_file\
└─ _tool\python\        ← python-3.12.x-embed-amd64 unpacked
```

`convert.bat` prefers `_tool\python\python.exe` when present, then falls back to `py -3` or
`python` on the machine.

## Self-test

Both builds accept a hidden `--selftest <folder>` argument that converts every `.HSP` in the
folder and writes `_selftest.txt` (windowed builds have no console, hence the file):

```bat
HSP2HEIC.exe --selftest samples
```

Exit code 0 means every file converted. This is how the release artifacts are checked against
the reference `.HEIC` files in `samples/`.
