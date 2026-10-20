# Panasonic HLG Photo (.HSP) → HEIC

**Lossless converter that turns Panasonic LUMIX HLG Photo files into HDR HEIC images
you can open on a phone.**

[中文](README.md) · [MIT License](LICENSE) · [Sample photos: CC BY-NC-SA 4.0](samples/README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.8%2B-3776AB.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)
![Lossless](https://img.shields.io/badge/pixel%20data-lossless-success.svg)

![GUI](docs/screenshot.png)

---

## Why

Panasonic's **HLG Photo** format (`.HSP`, available on LUMIX S1 / S5 / S5 II and others)
stores a 10-bit HLG HDR still — but only Panasonic's Windows extension and a Photoshop
plug-in can open it. Phones can't, so the HDR stays locked on the desktop.

**HEIC is just HEVC inside a HEIF container.** An `.HSP` already contains a HEVC Main10
bitstream, so there is no need to decode and re-encode anything: the stream can be
re-wrapped into HEIC with the correct colour tags, and every phone that speaks HEIC
(iPhone, iPad, Android) will open it, HLG HDR included.

## Download

| Build | File | For |
|---|---|---|
| **Windows GUI (recommended)** | [HSP2HEIC.exe](https://github.com/Baizhi-Angelica/panasonic-hsp-to-heic/releases/latest/download/HSP2HEIC.exe) | Double-click, pick a folder or photos |
| **Windows portable** | [HSP2HEIC-portable-win64.zip](https://github.com/Baizhi-Angelica/panasonic-hsp-to-heic/releases/latest/download/HSP2HEIC-portable-win64.zip) | Unzip and run, Python included, CLI / bat |
| Source | `python hsp2heic.py` | Python 3.8+, no third-party packages |

Everything is on the [Releases](https://github.com/Baizhi-Angelica/panasonic-hsp-to-heic/releases) page.

## 1. GUI (exe)

1. Double-click **`HSP2HEIC.exe`**.
2. Click **Choose folder…** (converts every `.HSP` inside, recursively) or **Choose photos…**
   (multi-select).
3. Results are written to a **`HEIC`** sub-folder next to the sources; originals stay untouched.
4. **Open output folder** takes you there.

Tick *Overwrite existing HEIC* to regenerate files; **Stop** cancels between files.

> **"Unknown publisher" warning?** The exe is not code-signed, so SmartScreen may
> interrupt once. Choose *More info → Run anyway*.
>
> **Antivirus false positive?** PyInstaller builds occasionally trip heuristics. Use the
> portable zip instead, or whitelist the exe.

## 2. Portable zip

```
HSP2HEIC-portable\
├─ convert.bat          ← double-click this
├─ hsp2heic.py
├─ 使用说明.txt
├─ raw_file\            ← put your .HSP files here
└─ _tool\python\        ← bundled Python, nothing to install
```

1. Drop your `.HSP` files into `raw_file\` (or any folder).
2. Double-click `convert.bat`.
3. Results appear in `raw_file\HEIC\`.

You can also **drag any folder** (or a few `.HSP` files) onto `convert.bat`; it works
recursively and writes a `HEIC\` sub-folder next to each source.

## 3. Command line / source

Python 3.8+ (standard library only, nothing to `pip install`):

```bash
python hsp2heic.py                        # convert ./raw_file
python hsp2heic.py "D:\Photos\Harbor"     # convert a folder
python hsp2heic.py a.HSP b.HSP            # convert individual files
```

| Option | Description |
|---|---|
| `--out DIR` | write all results to `DIR` instead of `HEIC\` sub-folders |
| `--force` | overwrite existing `.HEIC` files |
| `--replace` | delete the source `.HSP` after a successful conversion |
| `--no-recursive` | do not walk sub-folders |
| `--lang zh\|en` | force console language (defaults to the system UI language) |
| `-h`, `--help` | show help |

## Features

- **Truly lossless** — the HEVC bitstream is copied byte-for-byte, no decoding, no re-compression.
- **HDR preserved** — 10-bit 4:2:0, BT.2020 primaries, HLG transfer, BT.2020 non-constant matrix, limited range.
- **EXIF preserved** — camera, lens, capture time with timezone, shutter, aperture, ISO, focal length, author, copyright.
- **Fast** — about 10 ms per 24 MP photo.
- **Zero dependencies** — pure Python standard library; the Windows builds ship Python.
- **Bilingual** — GUI and CLI follow the system language.

## How it works

```
.HSP (TIFF container)
├── IFD0 + ExifIFD  ──────────────► rebuilt as standard EXIF
├── 64 KB Panasonic private block (dimensions, statistics — unused)
├── HEVC Main10 Annex B bitstream ─► copied into HEIF "mdat", NAL by NAL
└── JPEG previews (IFD1/IFD2)      (not used)

.HEIC (ISO/IEC 23008-12)
├── ftyp   heix / mif1 / miaf
├── meta   hvcC (VPS/SPS/PPS from the bitstream), colr nclx, ispe, pixi
├── mdat   the original slices
└── Exif   item linked with a cdsc reference
```

The only bytes this tool writes are container headers, the colour profile and the
EXIF block — the image data is untouched. Details in [docs/hsp-format.md](docs/hsp-format.md).

## Output

| Property | Value |
|---|---|
| Container | HEIC (`heix`, compatible with `mif1` + `miaf`) |
| Image | 5984 × 4000, 10-bit, 4:2:0 (same as the camera stream) |
| Colour | BT.2020 / HLG / BT.2020 NC, limited range (`nclx` 9/18/9, full_range = 0) |
| Metadata | standard EXIF (no MakerNote, see limitations) |
| Size | roughly the `.HSP` minus its embedded JPEG preview — 2.6–4.5 MB per 24 MP photo |
| Speed | ≈ 10 ms per photo |

## Compatibility

| Platform | Behaviour |
|---|---|
| iPhone / iPad (Photos) | Opens natively; HDR shown on HDR-capable displays |
| Windows 11 (Photos / Explorer) | Needs the free *HEIF Image Extension* from the Microsoft Store |
| Android / Google Photos | Opens with any HEIF-capable gallery; HDR depends on the device |
| SDR-only viewers | Tone-mapped to SDR by the OS; never washed-out or black |
| Messaging apps (WeChat etc.) | May re-encode to SDR JPEG on send — the original file is unaffected |

## Limitations

- Only **4:2:0, 10/12-bit HLG** HEVC streams are accepted — that is what LUMIX HLG Photo writes.
- Panasonic's **MakerNote** is dropped: it uses absolute file offsets, which cannot survive a container move.
- **GPS** is not carried over (none of the reference files contain it).
- EXIF `Orientation` is preserved as-is; no HEIF `irot` box is written. All reference files are orientation 1.
- Output is a plain **HLG HEIC**, not an Apple/ISO 21496-1 "gain map" HDR photo. iOS 18 and
  Android 15 gain-map support could be added in a future version.
- Windows Explorer's property panel only surfaces part of the EXIF for HEIC files; the metadata is
  in the file (check with exiftool, Lightroom, or on the iPad).

## Verification

- 13 photos shot on a **DC-S5 (firmware 2.8)** with an APO-SUMMICRON-SL 35 mm f/2.
- For every output, the HEVC slices are **byte-identical** to the source `.HSP`.
- All outputs decode correctly with **libheif 1.23.6** and the **Windows Imaging Component** (WIC).
- Colour tags verified as `nclx: primaries=9, transfer=18, matrix=9, full_range=0`.
- Both the exe and the portable build were self-tested against the samples; output hashes match.

## Samples

Three reference pairs live in [`samples/`](samples/README.md):

| File | Scene | Why this sample |
|---|---|---|
| `_PAN0301` | Harbour at dusk | bright sky + deep shadows |
| `_PAN0766` | Interior, backlit window | extreme dynamic range |
| `_PAN0976` | Lake and hills | smooth gradients, colour transition check |

They are licensed **CC BY-NC-SA 4.0** (photos), separate from the MIT-licensed code.

## License

- **Code** — [MIT](LICENSE), © 2026 Baizhi-Angelica.
- **Sample photographs** — [CC BY-NC-SA 4.0](samples/LICENSE-CC-BY-NC-SA-4.0.txt), © 2026 Baizhi-Angelica.

HEIC/HEVC patent licensing is separate from this repository; the tool only re-wraps
data you already own.

## Acknowledgements

- [libheif](https://github.com/strukturag/libheif) and its decoding stack, used to validate outputs.
- Everyone who documented the HLG Photo format before this.
