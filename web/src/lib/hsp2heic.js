/**
 * HSP -> HEIC lossless re-wrapper (browser / Node, no dependencies)
 * ===============================================================
 *
 * A Panasonic .HSP (HLG Photo) file is a TIFF wrapper around a HEVC Main10
 * bitstream (10-bit 4:2:0, BT.2020 + HLG).  HEIC is HEVC inside a HEIF
 * container, so the picture never has to be decoded: we only move the
 * original NAL units into a HEIF `mdat`, write the correct colour tags
 * (nclx = BT.2020 / HLG / BT.2020 NC / limited range) and rebuild EXIF.
 *
 * Direct port of hsp2heic.py — output is byte-identical to the Python tool.
 */

const TYPE_SIZE = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1,
  8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
};

// IFD0 tags that must not be copied as-is: offsets into the old file,
// or Panasonic's private compression marker.
const DROP_IFD0_TAGS = new Set([
  0x0103, // Compression (Panasonic private value 51176)
  0x0111, // StripOffsets
  0x0117, // StripByteCounts
  0x0201, // JPEGInterchangeFormat (preview)
  0x0202, // JPEGInterchangeFormatLength
  0x02bc, // XMP
  0x8769, // ExifIFD pointer (rebuilt)
  0x8825, // GPS pointer
  0x9001, 0x9002, 0x9003, 0x9004, 0x9005, // Panasonic private block
]);

// MakerNote uses absolute file offsets, so it cannot survive a container move.
const DROP_EXIF_TAGS = new Set([
  0x927c, // MakerNote
  0x8825, // GPS pointer
  0x8769, // ExifIFD pointer
  0xa005, // Interop pointer
]);

export class HspError extends Error {}

const err = (zh, en) => new HspError(`${zh} / ${en}`);

/* ------------------------------------------------------------------ */
/* Byte helpers                                                        */
/* ------------------------------------------------------------------ */

const utf8 = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const be16 = (v) => new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
const be32 = (v) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const be64num = (v) => be32(Math.floor(v / 0x100000000)).concat(be32(v >>> 0));
const le16 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const le32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const u16le = (d, o) => d[o] | (d[o + 1] << 8);
const u32le = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000;

/* ------------------------------------------------------------------ */
/* HEVC: split NAL units, read SPS, build hvcC                         */
/* ------------------------------------------------------------------ */

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0;
  }

  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }

  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw err('SPS 解析失败（exp-golomb 异常）', 'failed to parse SPS (bad exp-golomb code)');
    }
    if (!zeros) return 0;
    return Math.pow(2, zeros) - 1 + this.u(zeros);
  }
}

/** Remove HEVC emulation-prevention bytes (0x000003). */
function unescapeNal(b) {
  const out = [];
  const n = b.length;
  let i = 0;
  while (i < n) {
    if (i + 2 < n && b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 3) {
      out.push(0, 0);
      i += 3;
    } else {
      out.push(b[i]);
      i++;
    }
  }
  return Uint8Array.from(out);
}

function parsePtl(r, maxSubLayersMinus1) {
  const d = {};
  d.profile_space = r.u(2);
  d.tier_flag = r.u(1);
  d.profile_idc = r.u(5);
  d.compat_flags = r.u(32);
  d.constraint_flags = r.u(48);
  d.level_idc = r.u(8);
  const subProfile = [];
  const subLevel = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.u(1));
    subLevel.push(r.u(1));
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) r.u(2);
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) {
      r.u(2); r.u(1); r.u(5); r.u(32); r.u(48);
    }
    if (subLevel[i]) r.u(8);
  }
  return d;
}

/** Parse only the fields needed to build hvcC. */
function parseSps(nal) {
  const r = new BitReader(unescapeNal(nal.subarray(2)));
  const info = {};
  info.vps_id = r.u(4);
  info.max_sub_layers_minus1 = r.u(3);
  info.temporal_id_nesting = r.u(1);
  info.ptl = parsePtl(r, info.max_sub_layers_minus1);
  r.ue(); // sps_seq_parameter_set_id
  info.chroma_format_idc = r.ue();
  if (info.chroma_format_idc === 3) r.u(1); // separate_colour_plane_flag
  info.width = r.ue();
  info.height = r.ue();
  if (r.u(1)) { // conformance_window_flag
    r.ue(); r.ue(); r.ue(); r.ue();
  }
  info.bit_depth_luma_minus8 = r.ue();
  info.bit_depth_chroma_minus8 = r.ue();
  return info;
}

/** Annex-B stream -> list of NAL units (start codes stripped). */
function splitAnnexB(buf) {
  const nals = [];
  const n = buf.length;
  let i = 0;
  for (;;) {
    let j = -1;
    for (let k = i; k + 2 < n; k++) {
      if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) { j = k; break; }
    }
    if (j < 0) break;
    const start = j >= 1 && buf[j - 1] === 0 ? j - 1 : j;
    const sc = start + 4 <= n && buf[start] === 0 && buf[start + 1] === 0 && buf[start + 2] === 0 && buf[start + 3] === 1 ? 4 : 3;

    let k2 = -1;
    for (let k = start + sc; k + 2 < n; k++) {
      if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) { k2 = k; break; }
    }
    const end = k2 < 0 ? n : (k2 >= 1 && buf[k2 - 1] === 0 ? k2 - 1 : k2);
    const nal = buf.subarray(start + sc, end);
    if (nal.length) nals.push(nal);
    i = end;
    if (end >= n) break;
  }
  return nals;
}

function buildHvcc(vps, sps, pps, info) {
  const ptl = info.ptl;
  const parts = [];
  parts.push(Uint8Array.of(1)); // configurationVersion
  parts.push(Uint8Array.of((ptl.profile_space << 6) | (ptl.tier_flag << 5) | ptl.profile_idc));
  parts.push(be32(ptl.compat_flags >>> 0));
  // 48-bit constraint flags
  parts.push(Uint8Array.of(
    Math.floor(ptl.constraint_flags / Math.pow(2, 40)) & 0xff,
    Math.floor(ptl.constraint_flags / Math.pow(2, 32)) & 0xff,
    Math.floor(ptl.constraint_flags / Math.pow(2, 24)) & 0xff,
    Math.floor(ptl.constraint_flags / Math.pow(2, 16)) & 0xff,
    Math.floor(ptl.constraint_flags / Math.pow(2, 8)) & 0xff,
    ptl.constraint_flags & 0xff,
  ));
  parts.push(Uint8Array.of(ptl.level_idc));
  parts.push(be16(0xf000)); // min_spatial_segmentation_idc = 0
  parts.push(Uint8Array.of(0xfc)); // parallelismType = 0
  parts.push(Uint8Array.of(0xfc | (info.chroma_format_idc & 3)));
  parts.push(Uint8Array.of(0xf8 | (info.bit_depth_luma_minus8 & 7)));
  parts.push(Uint8Array.of(0xf8 | (info.bit_depth_chroma_minus8 & 7)));
  parts.push(new Uint8Array(2)); // avgFrameRate
  const numLayers = (info.max_sub_layers_minus1 + 1) & 7;
  parts.push(Uint8Array.of(0x0f | (numLayers << 3) | (info.temporal_id_nesting << 2)));
  const arrays = [[32, vps], [33, sps], [34, pps]];
  parts.push(Uint8Array.of(arrays.length));
  for (const [nalType, nal] of arrays) {
    parts.push(Uint8Array.of(0x80 | nalType)); // array_completeness = 1
    parts.push(be16(1));
    parts.push(be16(nal.length));
    parts.push(nal);
  }
  return concat(parts);
}

/* ------------------------------------------------------------------ */
/* TIFF / EXIF: read the original IFDs, rebuild one self-contained TIFF */
/* ------------------------------------------------------------------ */

function readIfd(data, off) {
  if (off <= 0 || off + 2 > data.length) throw err('IFD 偏移越界', 'IFD offset out of range');
  const count = u16le(data, off);
  if (count > 1000) throw err('IFD 条目数异常', 'unexpected IFD entry count');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const pos = off + 2 + i * 12;
    if (pos + 12 > data.length) throw err('IFD 条目越界', 'IFD entry out of range');
    const tag = u16le(data, pos);
    const typ = u16le(data, pos + 2);
    const cnt = u32le(data, pos + 4);
    const size = (TYPE_SIZE[typ] || 1) * cnt;
    let raw;
    if (size <= 4) {
      raw = data.subarray(pos + 8, pos + 8 + size);
    } else {
      const voff = u32le(data, pos + 8);
      if (voff + size > data.length) throw err('IFD 值偏移越界', 'IFD value offset out of range');
      raw = data.subarray(voff, voff + size);
    }
    entries.push([tag, typ, cnt, raw]);
  }
  return entries;
}

function buildExifTiff(ifd0In, exifIfdIn) {
  const ifd0 = ifd0In.filter((e) => !DROP_IFD0_TAGS.has(e[0]));
  const exifIfd = exifIfdIn.filter((e) => !DROP_EXIF_TAGS.has(e[0]));

  function layout(entries, start) {
    entries = entries.slice().sort((a, b) => a[0] - b[0]);
    const header = 2 + 12 * entries.length + 4;
    let cursor = start + header;
    const blocks = new Map();
    entries.forEach((e, i) => {
      if (e[3].length > 4) {
        blocks.set(i, cursor);
        cursor += e[3].length + (e[3].length & 1); // 2-byte alignment
      }
    });
    return { entries, blocks, cursor };
  }

  const ifd0Off = 8;
  const n0 = ifd0.length + 1; // + ExifIFD pointer
  const header0 = 2 + 12 * n0 + 4;
  const values0 = ifd0.reduce((acc, e) => (e[3].length > 4 ? acc + e[3].length + (e[3].length & 1) : acc), 0);
  const exifOff = ifd0Off + header0 + values0;

  const entries0WithPtr = ifd0.concat([[0x8769, 4, 1, le32(exifOff)]]);
  const l0 = layout(entries0WithPtr, ifd0Off);
  if (l0.cursor !== exifOff) {
    throw err('内部错误：ExifIFD 偏移计算不一致', 'internal error: inconsistent ExifIFD offset');
  }
  const l1 = layout(exifIfd, exifOff);

  function emit({ entries, blocks }) {
    const parts = [];
    parts.push(le16(entries.length));
    entries.forEach(([tag, typ, cnt, raw], i) => {
      parts.push(le16(tag), le16(typ), le32(cnt));
      if (raw.length <= 4) {
        const padded = new Uint8Array(4);
        padded.set(raw);
        parts.push(padded);
      } else {
        parts.push(le32(blocks.get(i)));
      }
    });
    parts.push(new Uint8Array(4)); // next IFD = 0
    entries.forEach((e, i) => {
      if (blocks.has(i)) {
        parts.push(e[3]);
        if (e[3].length & 1) parts.push(new Uint8Array(1));
      }
    });
    return concat(parts);
  }

  const tiff = concat([
    utf8('II'),
    le16(42),
    le32(ifd0Off),
    emit(l0),
    emit(l1),
  ]);
  return tiff;
}

/* ------------------------------------------------------------------ */
/* HEIF container                                                      */
/* ------------------------------------------------------------------ */

const box = (typ, payload) => concat([be32(8 + payload.length), utf8(typ), payload]);
const fullbox = (typ, version, flags, payload) =>
  box(typ, concat([Uint8Array.of(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), payload]));

function buildHeic(width, height, hvcc, slices, bitDepth, exifTiff) {
  const major = bitDepth <= 8 ? 'heic' : 'heix';
  const ftyp = box('ftyp', concat([utf8(major), be32(0), utf8('mif1'), utf8(major), utf8('miaf')]));

  const hdlr = fullbox('hdlr', 0, 0, concat([be32(0), utf8('pict'), new Uint8Array(12), new Uint8Array(1)]));
  const pitm = fullbox('pitm', 0, 0, be16(1));

  const ipco = box('ipco', concat([
    box('hvcC', hvcc),
    // nclx: BT.2020 primaries / HLG transfer / BT.2020 NC matrix / limited range
    box('colr', concat([utf8('nclx'), be16(9), be16(18), be16(9), Uint8Array.of(0)])),
    fullbox('ispe', 0, 0, concat([be32(width), be32(height)])),
    fullbox('pixi', 0, 0, Uint8Array.of(3, bitDepth, bitDepth, bitDepth)),
  ]));
  // associate properties with the primary image; hvcC is essential (0x80)
  const ipma = fullbox('ipma', 0, 0, concat([be32(1), be16(1), Uint8Array.of(4), Uint8Array.of(0x81, 0x02, 0x03, 0x04)]));
  const iprp = box('iprp', concat([ipco, ipma]));

  const imageData = concat(slices.map((nal) => concat([be32(nal.length), nal])));

  const items = [imageData];
  const infes = [fullbox('infe', 2, 0, concat([be16(1), be16(0), utf8('hvc1'), new Uint8Array(1)]))];
  let exifPayload = null;
  if (exifTiff) {
    // HEIF Exif item: 4-byte offset to the TIFF header + "Exif\0\0" + TIFF
    exifPayload = concat([be32(6), utf8('Exif'), new Uint8Array(2), exifTiff]);
    items.push(exifPayload);
    infes.push(fullbox('infe', 2, 0, concat([be16(2), be16(0), utf8('Exif'), new Uint8Array(1)])));
  }

  const iinf = fullbox('iinf', 0, 0, concat([be16(infes.length), ...infes]));

  const makeMeta = (offsets) => {
    const entries = [];
    items.forEach((payload, idx) => {
      const off = offsets[idx];
      // item_ID, data_ref_index, base_offset, extent_count, extent_offset, extent_length
      entries.push(concat([be16(idx + 1), be16(0), be32(off), be16(1), be32(0), be32(payload.length)]));
    });
    const iloc = fullbox('iloc', 0, 0, concat([Uint8Array.of(0x44, 0x40), be16(items.length), ...entries]));
    const iref = exifPayload
      // Exif item (2) describes the primary image (1)
      ? fullbox('iref', 0, 0, box('cdsc', concat([be16(2), be16(1), be16(1)])))
      : new Uint8Array(0);
    return fullbox('meta', 0, 0, concat([hdlr, iloc, iinf, pitm, iprp, iref]));
  };

  let meta = makeMeta(new Array(items.length).fill(0)); // first pass: fixed size
  const dataStart = ftyp.length + meta.length + 8; // + mdat header
  let cursor = dataStart;
  const offsets = items.map((payload) => {
    const off = cursor;
    cursor += payload.length;
    return off;
  });
  meta = makeMeta(offsets);
  const mdat = box('mdat', concat(items));
  return concat([ftyp, meta, mdat]);
}

/** Minimal structural self-check so a broken file is never produced. */
function validateHeic(data) {
  const ascii = (a, b) => String.fromCharCode(...data.subarray(a, b));
  if (data.length < 32 || ascii(4, 8) !== 'ftyp') throw err('输出文件缺少 ftyp', 'output has no ftyp box');
  if (!['heic', 'heix'].includes(ascii(8, 12))) throw err('输出文件品牌异常', 'output has an unexpected brand');

  let pos = 0;
  let hasMeta = false;
  let hasMdat = false;
  while (pos + 8 <= data.length) {
    const size = ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0;
    const typ = ascii(pos + 4, pos + 8);
    if (size < 8 || pos + size > data.length) throw err('输出文件 box 长度异常', 'output box size is invalid');
    if (typ === 'meta') hasMeta = true;
    else if (typ === 'mdat') hasMdat = true;
    pos += size;
  }
  if (!(hasMeta && hasMdat) || pos !== data.length) {
    throw err('输出文件结构不完整', 'output structure is incomplete');
  }
  const needle = concat([be16(9), be16(18), be16(9), Uint8Array.of(0)]);
  let foundColor = false;
  for (let i = 0; i + needle.length <= data.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) { foundColor = true; break; }
  }
  if (!foundColor) throw err('输出文件缺少 HLG 色彩标签', 'output has no HLG colour tag');
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read a .HSP file and return its parts.
 * @param {Uint8Array} data
 */
export function readHsp(data) {
  if (data.length < 16 || !(data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00)) {
    throw err('不是松下 HSP 文件（TIFF 头不匹配）', 'not a Panasonic HSP file (bad TIFF header)');
  }

  const ifd0 = readIfd(data, u32le(data, 4));
  const tags = new Map();
  for (const [t, typ, cnt, raw] of ifd0) tags.set(t, [typ, cnt, raw]);

  if (!tags.has(0x0111)) throw err('找不到主图偏移（StripOffsets）', 'StripOffsets (main image offset) not found');
  const streamOff = u32le(tags.get(0x0111)[2], 0);
  let streamLen;
  if (tags.has(0x9005)) streamLen = u32le(tags.get(0x9005)[2], 0);
  else streamLen = data.length - streamOff;
  if (streamOff <= 0 || streamOff + streamLen > data.length) {
    throw err('主图数据越界', 'main image data out of range');
  }

  const stream = data.subarray(streamOff, streamOff + streamLen);
  const nals = splitAnnexB(stream);
  let vps = null, sps = null, pps = null;
  const slices = [];
  for (const nal of nals) {
    const nalType = (nal[0] >> 1) & 0x3f;
    if (nalType === 32) vps = nal;
    else if (nalType === 33) sps = nal;
    else if (nalType === 34) pps = nal;
    else if (nalType <= 31) slices.push(nal); // VCL: picture slices
    // AUD (35) and SEI (39/40) are meaningless for a still image
  }

  if (!(vps && sps && pps)) throw err('HEVC 码流缺少参数集（VPS/SPS/PPS）', 'HEVC stream lacks parameter sets (VPS/SPS/PPS)');
  if (!slices.length) throw err('HEVC 码流中没有图像分片', 'HEVC stream has no image slices');

  const info = parseSps(sps);
  if (info.chroma_format_idc !== 1) {
    throw err(`只支持 4:2:0 的 HLG 码流（当前 chroma_format_idc=${info.chroma_format_idc}）`,
      `only 4:2:0 streams are supported (chroma_format_idc=${info.chroma_format_idc})`);
  }

  const bitDepth = info.bit_depth_luma_minus8 + 8;
  if (bitDepth !== 10 && bitDepth !== 12) {
    throw err(`只支持 10/12-bit 码流（当前 ${bitDepth}-bit）`, `only 10/12-bit streams are supported (got ${bitDepth}-bit)`);
  }

  let exifTiff = null;
  if (tags.has(0x8769)) {
    const exifOff = u32le(tags.get(0x8769)[2], 0);
    const exifIfd = readIfd(data, exifOff);
    exifTiff = buildExifTiff(ifd0, exifIfd);
  }

  return {
    width: info.width,
    height: info.height,
    bitDepth,
    hvcc: buildHvcc(vps, sps, pps, info),
    slices,
    exif: exifTiff,
    sourceBytes: data.length,
  };
}

/**
 * Convert one .HSP buffer into a HEIC file.
 * @param {Uint8Array} input raw .HSP bytes
 * @returns {{data: Uint8Array, meta: object}}
 */
export function convertHsp(input) {
  const meta = readHsp(input);
  const data = buildHeic(meta.width, meta.height, meta.hvcc, meta.slices, meta.bitDepth, meta.exif);
  validateHeic(data);
  return {
    data,
    meta: {
      width: meta.width,
      height: meta.height,
      bitDepth: meta.bitDepth,
      sourceBytes: meta.sourceBytes,
      outputBytes: data.length,
      slices: meta.slices.length,
      hasExif: !!meta.exif,
    },
  };
}
