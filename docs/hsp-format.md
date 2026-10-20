# Panasonic HLG Photo (`.HSP`) format notes

Reverse-engineered from 13 files shot on a **Panasonic DC-S5, firmware 2.8**,
5984 × 4000. Everything below is what the converter relies on.

## 1. Outer container: TIFF

The file is a little-endian TIFF (`II`, magic 42) whose IFD0 sits at offset 8.
IFD0 has 15 entries:

| Tag | Name | Value in the samples |
|---|---|---|
| `0x0103` | Compression | `51176` — a **Panasonic private** code, not a TIFF compression |
| `0x010F` | Make | `Panasonic` |
| `0x0110` | Model | `DC-S5` |
| `0x0111` | StripOffsets | offset of the HEVC stream (e.g. `818688`) |
| `0x0112` | Orientation | `1` |
| `0x0128` | ResolutionUnit | `2` (inch) |
| `0x0131` | Software | `Ver.2.8` |
| `0x0132` | DateTime | capture time, no timezone |
| `0x013B` | Artist | author name |
| `0x02BC` | XMP | 396 bytes, only `xmp:Rating` |
| `0x8298` | Copyright | author name |
| `0x8769` | ExifIFD | pointer to the 41-entry Exif IFD |
| `0x9001` | private | offset of the 64 KB private block |
| `0x9002` | private | size of that block (`65536`) |
| `0x9005` | private | length of the HEVC stream |

In every sample `StripOffsets + 0x9005 == file size`, i.e. the HEVC stream runs to
the end of the file. IFD1 and IFD2 (chained through the `next IFD` pointer) are
JPEG previews (`Compression = 6`): one around 1620 × 1080 / 700 KB, one much
smaller. They carry no EXIF of their own.

## 2. The 64 KB private block

A sequence of big-endian 32-bit values. It starts `1, 5984, 4000, 17, 7, 26, …`
— image dimensions followed by what look like tone-mapping / statistics data
(the same numbers appear as a large lookup table). Panasonic's Windows viewer and
Photoshop plug-in use it to render SDR previews. **A HEIC conversion does not need it.**

## 3. Main image: HEVC Main10, Annex B

```
AUD(35) VPS(32) SPS(33) PPS(34) SEI(39)×5 slice(20)×8
```

- SPS: `profile_idc = 2` (Main 10), `level_idc = 180` (level 6.0, high tier),
  `chroma_format_idc = 1` (4:2:0), `bit_depth_luma_minus8 = 2` (10-bit),
  `pic_width = 5984`, `pic_height = 4000`.
- SPS VUI: `colour_primaries = 9` (BT.2020), `transfer_characteristics = 18` (HLG),
  `matrix_coefficients = 9` (BT.2020 non-constant), `video_full_range_flag = 0`.
- A single access unit; the eight slice NALs are one still picture
  (`first_mb_in_slice` 0…7, `IDR_W_RADL`).
- The SEI NALs are video-flavoured (buffering period, picture timing, recovery point,
  user data) and are dropped when re-muxing.

No decoding is needed: slice NALs can be copied verbatim.

## 4. HEIF layout written by this tool

```
ftyp  'heix'  minor 0  compatible: mif1 heix miaf
meta
├── hdlr  'pict'
├── iloc  v0, offset_size=4, length_size=4, base_offset_size=4
│         item 1 → image payload, item 2 → Exif payload (absolute offsets)
├── iinf  v0
│   ├── infe v2  id=1  'hvc1'
│   └── infe v2  id=2  'Exif'
├── pitm  v0  primary = 1
├── iprp
│   ├── ipco
│   │   ├── hvcC   (VPS/SPS/PPS, marked essential)
│   │   ├── colr   nclx: 9 / 18 / 9, full_range = 0
│   │   ├── ispe   width, height
│   │   └── pixi   3 channels × 10-bit
│   └── ipma   item 1 → properties 1..4, first one essential (0x81 0x02 0x03 0x04)
└── iref  cdsc: Exif item 2 → image item 1
mdat
├── item 1: 8 × (uint32 length + NAL)
└── item 2: uint32 offset (= 6) + "Exif\0\0" + rebuilt TIFF
```

## 5. `hvcC`

`hvcC` is built from the SPS `profile_tier_level` and the parameter-set NALs:

| Field | Source |
|---|---|
| `configurationVersion` | 1 |
| `general_profile_space/tier/idc` | SPS PTL |
| `general_profile_compatibility_flags` | SPS PTL (32 bits) |
| `general_constraint_indicator_flags` | SPS PTL (48 bits) |
| `general_level_idc` | SPS (`180`) |
| `min_spatial_segmentation_idc` | 0 |
| `parallelismType` | 0 |
| `chromaFormat` | SPS `chroma_format_idc` |
| `bitDepthLumaMinus8`, `bitDepthChromaMinus8` | SPS |
| `numTemporalLayers`, `temporalIdNested` | SPS `sps_max_sub_layers_minus1`, nesting flag |
| `lengthSizeMinusOne` | 3 (4-byte NAL lengths in `mdat`) |
| arrays | VPS (32), SPS (33), PPS (34), `array_completeness = 1` |

## 6. EXIF rebuild

The original IFD0 and ExifIFD are re-emitted as a standalone TIFF:

- copied: camera/lens/time/shooting parameters (`Make`, `Model`, `Orientation`,
  `XResolution`, `Software`, `DateTime`, `Artist`, `Copyright`, plus all 41 Exif IFD tags
  such as `ExposureTime`, `FNumber`, `ISOSpeedRatings`, `DateTimeOriginal`,
  `OffsetTimeOriginal`, `LensModel`, `BodySerialNumber`, …);
- dropped: `StripOffsets`, `StripByteCounts`, `Compression`, thumbnail pointers,
  XMP, Panasonic private tags, and the **MakerNote** (absolute offsets),
  which also removes GPS/Interop pointers;
- pointers are recomputed, tags sorted, values 2-byte aligned, `next IFD = 0`;
- the Exif IFD is linked with a fresh `0x8769` pointer.

## 7. How outputs were validated

- Slice NALs compared byte-for-byte against the source `.HSP` — identical.
- Decoded with **libheif 1.23.6** and **Windows Imaging Component** (the HEIF
  codec used by Explorer and Photos): every file opens at 5984 × 4000.
- `nclx` read back as `color_primaries=9`, `transfer_characteristics=18`,
  `matrix_coefficients=9`, `full_range_flag=0`.
