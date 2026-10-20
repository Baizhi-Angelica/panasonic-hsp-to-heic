#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HSP -> HEIC lossless converter / 无损转换器
===========================================

Panasonic HLG Photo (.HSP) -> HDR HEIC, without decoding or re-encoding.

A .HSP file is a TIFF wrapper around a HEVC Main10 bitstream
(10-bit 4:2:0, BT.2020 + HLG).  HEIC is just HEVC inside a HEIF container,
so this tool re-wraps the original bitstream, writes the correct colour
tags (nclx = BT.2020 / HLG / BT.2020 NC / limited range) and keeps EXIF.
Pixel data stays byte-for-byte identical to the camera stream.

松下 S5 的 .HSP (HLG Photo) 其实是 TIFF 外壳 + 一段 HEVC Main10 码流
（10-bit 4:2:0、BT.2020 + HLG）。HEIC 就是 HEVC 的 HEIF 容器，因此本工具
不做解码、不做二次压缩，只把码流原样搬进 HEIC，并写入正确的色彩标签
和 EXIF。画质与相机原始码流逐字节一致。

Usage / 用法:
  python hsp2heic.py                      # convert raw_file/ (or the script's folder)
  python hsp2heic.py <folder-or-HSP>...   # convert given paths
  python hsp2heic.py --out DIR ...        # custom output folder
  python hsp2heic.py --replace ...        # delete source HSP after success
  python hsp2heic.py --force ...          # overwrite existing HEIC
  python hsp2heic.py --no-recursive ...   # do not walk sub-folders
  python hsp2heic.py --lang en|zh ...     # console language

Output defaults to a "HEIC" sub-folder next to each source file; sources
are never modified unless --replace is given.
默认输出到源文件旁的 HEIC 子文件夹，源文件保留（除非指定 --replace）。
"""

import os
import sys
import struct
import time

VERSION = "1.1"
OUT_SUBDIR = "HEIC"
HEIC_SUFFIX = ".HEIC"


# --------------------------------------------------------------------------
# Language / 语言
# --------------------------------------------------------------------------

def _default_lang():
    env = os.environ.get("HSP2HEIC_LANG", "").strip().lower()
    if env.startswith("zh"):
        return "zh"
    if env.startswith("en"):
        return "en"
    try:  # Windows: use the UI language (0x04 = Chinese)
        import ctypes
        lang_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
        if (lang_id & 0x3FF) == 0x04:
            return "zh"
        return "en"
    except Exception:
        pass
    try:
        import locale
        name = (locale.getlocale()[0] or "").lower()
        if name.startswith("zh"):
            return "zh"
    except Exception:
        pass
    return "en"


LANG = _default_lang()


def tr(zh, en):
    """Pick the string for the current language."""
    return zh if LANG == "zh" else en


# TIFF data type -> bytes per element
TYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1,
    8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
}

# IFD0 tags that must not be copied as-is: they are offsets into the old file,
# or Panasonic's private compression marker.
DROP_IFD0_TAGS = {
    0x0103,  # Compression (Panasonic private value 51176)
    0x0111,  # StripOffsets
    0x0117,  # StripByteCounts
    0x0201,  # JPEGInterchangeFormat (preview)
    0x0202,  # JPEGInterchangeFormatLength
    0x02BC,  # XMP (only a rating in these files)
    0x8769,  # ExifIFD pointer (rebuilt below)
    0x8825,  # GPS pointer (not carried over)
    0x9001, 0x9002, 0x9003, 0x9004, 0x9005,  # Panasonic private block
}

# MakerNote uses absolute file offsets, so it cannot survive a container move.
DROP_EXIF_TAGS = {
    0x927C,  # MakerNote
    0x8825,  # GPS pointer
    0x8769,  # ExifIFD pointer
    0xA005,  # Interop pointer
}


class HspError(Exception):
    """The file does not look like a supported HSP."""


# --------------------------------------------------------------------------
# HEVC: split NAL units, read SPS, build hvcC
# --------------------------------------------------------------------------

class BitReader:
    __slots__ = ("data", "pos")

    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.data[self.pos >> 3] >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v

    def ue(self):
        zeros = 0
        while self.u(1) == 0:
            zeros += 1
            if zeros > 31:
                raise HspError(tr("SPS 解析失败（exp-golomb 异常）",
                                  "failed to parse SPS (bad exp-golomb code)"))
        return (1 << zeros) - 1 + (self.u(zeros) if zeros else 0)


def unescape_nal(b):
    """Remove HEVC emulation-prevention bytes (0x000003)."""
    out = bytearray()
    i, n = 0, len(b)
    while i < n:
        if i + 2 < n and b[i] == 0 and b[i + 1] == 0 and b[i + 2] == 3:
            out += b[i:i + 2]
            i += 3
        else:
            out.append(b[i])
            i += 1
    return bytes(out)


def parse_ptl(r, max_sub_layers_minus1):
    d = {}
    d["profile_space"] = r.u(2)
    d["tier_flag"] = r.u(1)
    d["profile_idc"] = r.u(5)
    d["compat_flags"] = r.u(32)
    d["constraint_flags"] = r.u(48)
    d["level_idc"] = r.u(8)
    sub_profile, sub_level = [], []
    for _ in range(max_sub_layers_minus1):
        sub_profile.append(r.u(1))
        sub_level.append(r.u(1))
    if max_sub_layers_minus1 > 0:
        for _ in range(max_sub_layers_minus1, 8):
            r.u(2)
    for i in range(max_sub_layers_minus1):
        if sub_profile[i]:
            r.u(2); r.u(1); r.u(5); r.u(32); r.u(48)
        if sub_level[i]:
            r.u(8)
    return d


def parse_sps(nal):
    """Parse only the fields needed to build hvcC."""
    r = BitReader(unescape_nal(nal[2:]))
    info = {}
    info["vps_id"] = r.u(4)
    info["max_sub_layers_minus1"] = r.u(3)
    info["temporal_id_nesting"] = r.u(1)
    info["ptl"] = parse_ptl(r, info["max_sub_layers_minus1"])
    r.ue()  # sps_seq_parameter_set_id
    info["chroma_format_idc"] = r.ue()
    if info["chroma_format_idc"] == 3:
        r.u(1)  # separate_colour_plane_flag
    info["width"] = r.ue()
    info["height"] = r.ue()
    if r.u(1):  # conformance_window_flag
        r.ue(); r.ue(); r.ue(); r.ue()
    info["bit_depth_luma_minus8"] = r.ue()
    info["bit_depth_chroma_minus8"] = r.ue()
    return info


def split_annexb(buf):
    """Annex-B stream -> list of NAL units (start codes stripped)."""
    nals = []
    i, n = 0, len(buf)
    while True:
        j = buf.find(b"\x00\x00\x01", i)
        if j < 0:
            break
        start = j - 1 if (j >= 1 and buf[j - 1] == 0) else j
        sc = 4 if buf[start:start + 4] == b"\x00\x00\x00\x01" else 3
        k = buf.find(b"\x00\x00\x01", start + sc)
        end = (k - 1 if (k >= 1 and buf[k - 1] == 0) else k) if k >= 0 else n
        nal = buf[start + sc:end]
        if nal:
            nals.append(nal)
        i = end
    return nals


def build_hvcc(vps, sps, pps, info):
    ptl = info["ptl"]
    b = bytearray()
    b.append(1)  # configurationVersion
    b.append((ptl["profile_space"] << 6) | (ptl["tier_flag"] << 5) | ptl["profile_idc"])
    b += ptl["compat_flags"].to_bytes(4, "big")
    b += ptl["constraint_flags"].to_bytes(6, "big")
    b.append(ptl["level_idc"])
    b += (0xF000).to_bytes(2, "big")  # min_spatial_segmentation_idc = 0
    b.append(0xFC)                    # parallelismType = 0
    b.append(0xFC | (info["chroma_format_idc"] & 3))
    b.append(0xF8 | (info["bit_depth_luma_minus8"] & 7))
    b.append(0xF8 | (info["bit_depth_chroma_minus8"] & 7))
    b += b"\x00\x00"                  # avgFrameRate
    num_layers = (info["max_sub_layers_minus1"] + 1) & 7
    b.append(0x0F | (num_layers << 3) | (info["temporal_id_nesting"] << 2))
    arrays = [(32, vps), (33, sps), (34, pps)]
    b.append(len(arrays))
    for nal_type, nal in arrays:
        b.append(0x80 | nal_type)  # array_completeness = 1
        b += struct.pack(">H", 1)
        b += struct.pack(">H", len(nal)) + nal
    return bytes(b)


# --------------------------------------------------------------------------
# TIFF / EXIF: read the original IFDs, rebuild one self-contained TIFF
# --------------------------------------------------------------------------

def read_ifd(data, off):
    if off <= 0 or off + 2 > len(data):
        raise HspError(tr("IFD 偏移越界", "IFD offset out of range"))
    count = struct.unpack("<H", data[off:off + 2])[0]
    if count > 1000:
        raise HspError(tr("IFD 条目数异常", "unexpected IFD entry count"))
    entries = []
    for i in range(count):
        pos = off + 2 + i * 12
        if pos + 12 > len(data):
            raise HspError(tr("IFD 条目越界", "IFD entry out of range"))
        tag, typ, cnt = struct.unpack("<HHI", data[pos:pos + 8])
        size = TYPE_SIZE.get(typ, 1) * cnt
        if size <= 4:
            raw = data[pos + 8:pos + 8 + size]
        else:
            voff = struct.unpack("<I", data[pos + 8:pos + 12])[0]
            if voff + size > len(data):
                raise HspError(tr("IFD 值偏移越界", "IFD value offset out of range"))
            raw = data[voff:voff + size]
        entries.append((tag, typ, cnt, raw))
    return entries


def build_exif_tiff(ifd0, exif_ifd):
    """Rebuild IFD0 + ExifIFD as a standalone, self-consistent TIFF block."""
    ifd0 = [e for e in ifd0 if e[0] not in DROP_IFD0_TAGS]
    exif_ifd = [e for e in exif_ifd if e[0] not in DROP_EXIF_TAGS]

    def layout(entries, start):
        entries = sorted(entries, key=lambda e: e[0])
        header = 2 + 12 * len(entries) + 4
        cursor = start + header
        blocks = {}
        for i, (tag, typ, cnt, raw) in enumerate(entries):
            if len(raw) > 4:
                blocks[i] = cursor
                cursor += len(raw) + (len(raw) & 1)   # 2-byte alignment
        return entries, blocks, cursor

    ifd0_off = 8
    n0 = len(ifd0) + 1                              # + ExifIFD pointer
    header0 = 2 + 12 * n0 + 4
    values0 = sum(len(raw) + (len(raw) & 1) for _, _, _, raw in ifd0 if len(raw) > 4)
    exif_off = ifd0_off + header0 + values0

    entries0 = ifd0 + [(0x8769, 4, 1, struct.pack("<I", exif_off))]
    entries0, blocks0, after0 = layout(entries0, ifd0_off)
    if after0 != exif_off:
        raise HspError(tr("内部错误：ExifIFD 偏移计算不一致",
                          "internal error: inconsistent ExifIFD offset"))
    entries1, blocks1, _ = layout(exif_ifd, exif_off)

    def emit(entries, blocks):
        out = bytearray()
        out += struct.pack("<H", len(entries))
        for i, (tag, typ, cnt, raw) in enumerate(entries):
            if len(raw) <= 4:
                out += struct.pack("<HHI", tag, typ, cnt) + raw.ljust(4, b"\x00")
            else:
                out += struct.pack("<HHI", tag, typ, cnt) + struct.pack("<I", blocks[i])
        out += b"\x00\x00\x00\x00"                  # next IFD = 0
        for i, (tag, typ, cnt, raw) in enumerate(entries):
            if i in blocks:
                out += raw + (b"\x00" if len(raw) & 1 else b"")
        return bytes(out)

    tiff = b"II" + struct.pack("<H", 42) + struct.pack("<I", ifd0_off)
    tiff += emit(entries0, blocks0)
    if len(tiff) != exif_off:
        raise HspError(tr("内部错误：EXIF 长度不一致",
                          "internal error: inconsistent EXIF length"))
    tiff += emit(entries1, blocks1)
    return tiff


# --------------------------------------------------------------------------
# HEIF container
# --------------------------------------------------------------------------

def box(typ, payload):
    return struct.pack(">I", 8 + len(payload)) + typ + payload


def fullbox(typ, version, flags, payload):
    return box(typ, bytes([version]) + flags.to_bytes(3, "big") + payload)


def build_heic(width, height, hvcc, slices, bit_depth, exif_tiff=None):
    """Build a single-image HEIC according to ISO/IEC 23008-12."""
    major = b"heic" if bit_depth <= 8 else b"heix"
    ftyp = box(b"ftyp", major + struct.pack(">I", 0) + b"mif1" + major + b"miaf")

    hdlr = fullbox(b"hdlr", 0, 0, struct.pack(">I", 0) + b"pict" + b"\x00" * 12 + b"\x00")
    pitm = fullbox(b"pitm", 0, 0, struct.pack(">H", 1))

    ipco = box(
        b"ipco",
        box(b"hvcC", hvcc)
        # nclx: BT.2020 primaries / HLG transfer / BT.2020 NC matrix / limited range
        + box(b"colr", b"nclx" + struct.pack(">HHHB", 9, 18, 9, 0))
        + fullbox(b"ispe", 0, 0, struct.pack(">II", width, height))
        + fullbox(b"pixi", 0, 0, bytes([3, bit_depth, bit_depth, bit_depth])),
    )
    # associate properties with the primary image; hvcC is essential (0x80)
    ipma = fullbox(b"ipma", 0, 0,
                   struct.pack(">I", 1) + struct.pack(">H", 1) + bytes([4]) + bytes([0x81, 0x02, 0x03, 0x04]))
    iprp = box(b"iprp", ipco + ipma)

    image_data = b"".join(struct.pack(">I", len(n)) + n for n in slices)

    items = [image_data]
    infes = [fullbox(b"infe", 2, 0, struct.pack(">HH", 1, 0) + b"hvc1" + b"\x00")]
    exif_payload = None
    if exif_tiff:
        # HEIF Exif item: 4-byte offset to the TIFF header + "Exif\0\0" + TIFF
        exif_payload = struct.pack(">I", 6) + b"Exif\x00\x00" + exif_tiff
        items.append(exif_payload)
        infes.append(fullbox(b"infe", 2, 0, struct.pack(">HH", 2, 0) + b"Exif" + b"\x00"))

    iinf = fullbox(b"iinf", 0, 0, struct.pack(">H", len(infes)) + b"".join(infes))

    def make_meta(offsets):
        entries = b""
        for item_id, (off, payload) in enumerate(zip(offsets, items), start=1):
            # item_ID, data_ref_index, base_offset, extent_count, extent_offset, extent_length
            entries += struct.pack(">HHIHII", item_id, 0, off, 1, 0, len(payload))
        iloc = fullbox(b"iloc", 0, 0, bytes([0x44, 0x40]) + struct.pack(">H", len(items)) + entries)
        iref = b""
        if exif_payload:
            # Exif item (2) describes the primary image (1)
            iref = fullbox(b"iref", 0, 0, box(b"cdsc", struct.pack(">HHH", 2, 1, 1)))
        return fullbox(b"meta", 0, 0, hdlr + iloc + iinf + pitm + iprp + iref)

    meta = make_meta([0] * len(items))              # first pass: fixed size
    data_start = len(ftyp) + len(meta) + 8          # + mdat header
    offsets, cursor = [], data_start
    for payload in items:
        offsets.append(cursor)
        cursor += len(payload)
    meta = make_meta(offsets)
    mdat = box(b"mdat", b"".join(items))
    return ftyp + meta + mdat


def validate_heic(data):
    """Minimal structural self-check so a broken file is never written."""
    if len(data) < 32 or data[4:8] != b"ftyp":
        raise HspError(tr("输出文件缺少 ftyp", "output has no ftyp box"))
    if data[8:12] not in (b"heic", b"heix"):
        raise HspError(tr("输出文件品牌异常", "output has an unexpected brand"))
    pos, has_meta, has_mdat = 0, False, False
    while pos + 8 <= len(data):
        size = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        if size < 8 or pos + size > len(data):
            raise HspError(tr("输出文件 box 长度异常", "output box size is invalid"))
        if typ == b"meta":
            has_meta = True
        elif typ == b"mdat":
            has_mdat = True
        pos += size
    if not (has_meta and has_mdat) or pos != len(data):
        raise HspError(tr("输出文件结构不完整", "output structure is incomplete"))
    if b"nclx" not in data or struct.pack(">HHHB", 9, 18, 9, 0) not in data:
        raise HspError(tr("输出文件缺少 HLG 色彩标签", "output has no HLG colour tag"))


# --------------------------------------------------------------------------
# HSP parsing and conversion
# --------------------------------------------------------------------------

def read_hsp(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 16 or data[:4] != b"II*\x00":
        raise HspError(tr("不是松下 HSP 文件（TIFF 头不匹配）",
                          "not a Panasonic HSP file (bad TIFF header)"))

    ifd0 = read_ifd(data, struct.unpack("<I", data[4:8])[0])
    tags = {t: (typ, cnt, raw) for t, typ, cnt, raw in ifd0}

    if 0x0111 not in tags:
        raise HspError(tr("找不到主图偏移（StripOffsets）",
                          "StripOffsets (main image offset) not found"))
    stream_off = struct.unpack("<I", tags[0x0111][2])[0]
    if 0x9005 in tags:
        stream_len = struct.unpack("<I", tags[0x9005][2])[0]
    else:
        stream_len = len(data) - stream_off
    if stream_off <= 0 or stream_off + stream_len > len(data):
        raise HspError(tr("主图数据越界", "main image data out of range"))

    stream = data[stream_off:stream_off + stream_len]
    nals = split_annexb(stream)
    vps = sps = pps = None
    slices = []
    for nal in nals:
        nal_type = (nal[0] >> 1) & 0x3F
        if nal_type == 32:
            vps = nal
        elif nal_type == 33:
            sps = nal
        elif nal_type == 34:
            pps = nal
        elif nal_type <= 31:          # VCL: picture slices
            slices.append(nal)
        # AUD (35) and SEI (39/40) are meaningless for a still image

    if not (vps and sps and pps):
        raise HspError(tr("HEVC 码流缺少参数集（VPS/SPS/PPS）",
                          "HEVC stream lacks parameter sets (VPS/SPS/PPS)"))
    if not slices:
        raise HspError(tr("HEVC 码流中没有图像分片", "HEVC stream has no image slices"))

    info = parse_sps(sps)
    if info["chroma_format_idc"] != 1:
        raise HspError(tr("只支持 4:2:0 的 HLG 码流（当前 chroma_format_idc=%d）",
                          "only 4:2:0 streams are supported (chroma_format_idc=%d)")
                       % info["chroma_format_idc"])

    bit_depth = info["bit_depth_luma_minus8"] + 8
    if bit_depth not in (10, 12):
        raise HspError(tr("只支持 10/12-bit 码流（当前 %d-bit）",
                          "only 10/12-bit streams are supported (got %d-bit)") % bit_depth)

    exif_tiff = None
    if 0x8769 in tags:
        exif_off = struct.unpack("<I", tags[0x8769][2])[0]
        exif_ifd = read_ifd(data, exif_off)
        exif_tiff = build_exif_tiff(ifd0, exif_ifd)

    return {
        "width": info["width"],
        "height": info["height"],
        "bit_depth": bit_depth,
        "hvcc": build_hvcc(vps, sps, pps, info),
        "slices": slices,
        "exif": exif_tiff,
        "bytes": len(data),
    }


def convert_file(src, dst, force=False):
    meta = read_hsp(src)
    data = build_heic(meta["width"], meta["height"], meta["hvcc"],
                      meta["slices"], meta["bit_depth"], meta["exif"])
    validate_heic(data)
    if os.path.exists(dst) and not force:
        return meta, None, "skip"
    tmp = dst + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dst)
    return meta, len(data), "ok"


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

def find_sources(paths, recursive=True):
    """Expand targets into a list of .HSP files."""
    found = []
    for p in paths:
        p = os.path.abspath(p)
        if os.path.isfile(p):
            if p.lower().endswith(".hsp"):
                found.append(p)
        elif os.path.isdir(p):
            if recursive:
                for root, dirs, files in os.walk(p):
                    dirs[:] = [d for d in dirs if d.upper() != OUT_SUBDIR]
                    for name in files:
                        if name.lower().endswith(".hsp"):
                            found.append(os.path.join(root, name))
            else:
                for name in os.listdir(p):
                    full = os.path.join(p, name)
                    if os.path.isfile(full) and name.lower().endswith(".hsp"):
                        found.append(full)
    seen, uniq = set(), []
    for p in found:
        key = os.path.normcase(p)
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def default_targets():
    root = os.path.dirname(os.path.abspath(__file__))
    raw = os.path.join(root, "raw_file")
    return [raw] if os.path.isdir(raw) else [root]


def human(n):
    return "%.2f MB" % (n / 1048576.0) if n >= 1024 * 1024 else "%.1f KB" % (n / 1024.0)


def parse_args(argv):
    opts = {"out": None, "force": False, "replace": False,
            "recursive": True, "lang": None, "paths": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help", "/?"):
            print(__doc__)
            sys.exit(0)
        elif a == "--out":
            i += 1
            if i >= len(argv):
                raise SystemExit(tr("--out 需要一个目录参数", "--out requires a directory"))
            opts["out"] = argv[i]
        elif a == "--force":
            opts["force"] = True
        elif a == "--replace":
            opts["replace"] = True
        elif a == "--no-recursive":
            opts["recursive"] = False
        elif a == "--lang":
            i += 1
            if i >= len(argv) or argv[i] not in ("zh", "en"):
                raise SystemExit(tr("--lang 只接受 zh 或 en", "--lang accepts only zh or en"))
            opts["lang"] = argv[i]
        elif a.startswith("-"):
            raise SystemExit(tr("未知参数: %s", "unknown option: %s") % a)
        else:
            opts["paths"].append(a)
        i += 1
    return opts


def main(argv):
    global LANG
    opts = parse_args(argv)
    if opts["lang"]:
        LANG = opts["lang"]

    targets = opts["paths"] or default_targets()
    sources = find_sources(targets, opts["recursive"])

    print("=" * 68)
    print(tr(" HSP -> HEIC 无损转换  v%s", " HSP -> HEIC lossless converter  v%s") % VERSION)
    print("=" * 68)
    print(tr("目标: %s", "Target: %s") % "; ".join(os.path.abspath(t) for t in targets))
    if not sources:
        print(tr("\n没有找到 .HSP 文件。", "\nNo .HSP files found."))
        print(tr("把装有 HSP 的文件夹拖到本程序图标上，或双击运行（默认转换 raw_file）。",
                 "Drag a folder containing .HSP files onto this program, or just run it "
                 "(defaults to raw_file/)."))
        return 2

    print(tr("找到 %d 个 HSP 文件\n", "Found %d HSP file(s)\n") % len(sources))
    ok = skipped = failed = 0
    total_bytes = 0
    out_dirs = []
    errors = []
    t_all = time.time()

    for idx, src in enumerate(sources, 1):
        stem = os.path.splitext(os.path.basename(src))[0]
        if opts["out"]:
            out_dir = os.path.abspath(opts["out"])
        else:
            out_dir = os.path.join(os.path.dirname(src), OUT_SUBDIR)
        dst = os.path.join(out_dir, stem + HEIC_SUFFIX)
        if out_dir not in out_dirs:
            out_dirs.append(out_dir)
        try:
            os.makedirs(out_dir, exist_ok=True)
            t0 = time.time()
            meta, out_size, status = convert_file(src, dst, opts["force"])
            ms = (time.time() - t0) * 1000
            if status == "skip":
                skipped += 1
                print(tr("[%2d/%2d] %-14s 跳过（已存在 %s）",
                         "[%2d/%2d] %-14s skipped (%s already exists)")
                      % (idx, len(sources), os.path.basename(src), HEIC_SUFFIX))
                continue
            ok += 1
            total_bytes += out_size
            print("[%2d/%2d] %-14s -> %-14s %dx%d %d-bit  %s  %.0f ms" % (
                idx, len(sources), os.path.basename(src), os.path.basename(dst),
                meta["width"], meta["height"], meta["bit_depth"], human(out_size), ms))
            if opts["replace"]:
                try:
                    os.remove(src)
                except OSError as e:
                    print(tr("      警告：删除原文件失败：%s",
                             "      warning: failed to delete source: %s") % e)
        except Exception as e:
            failed += 1
            errors.append((src, e))
            print(tr("[%2d/%2d] %-14s 失败：%s", "[%2d/%2d] %-14s failed: %s")
                  % (idx, len(sources), os.path.basename(src), e))

    cost = time.time() - t_all
    print("\n" + "-" * 68)
    print(tr("完成：成功 %d，跳过 %d，失败 %d，用时 %.2f 秒，共写出 %s",
             "Done: %d ok, %d skipped, %d failed in %.2f s, %s written")
          % (ok, skipped, failed, cost, human(total_bytes)))
    if ok or skipped:
        for d in out_dirs[:5]:
            print(tr("输出目录：%s", "Output: %s") % d)
    if errors:
        print(tr("\n失败详情：", "\nFailures:"))
        for src, e in errors:
            print("  %s\n    %s" % (src, e))
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print(tr("\n已取消。", "\nCancelled."))
        sys.exit(130)
    except Exception as exc:  # keep the console window informative
        print(tr("\n发生未预期的错误：%s", "\nUnexpected error: %s") % exc)
        sys.exit(1)
