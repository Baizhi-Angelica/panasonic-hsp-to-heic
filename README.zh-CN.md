# 松下 HLG Photo (.HSP) → HEIC

**把松下 LUMIX 的 HLG Photo 文件无损转换成手机上能直接看的 HDR HEIC。**

[English](README.md) · [MIT 协议](LICENSE) · [样片：CC BY-NC-SA 4.0](samples/README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.8%2B-3776AB.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)
![Lossless](https://img.shields.io/badge/pixel%20data-lossless-success.svg)

---

## 为什么需要它

松下的 **HLG Photo** 格式（`.HSP`，S1 / S5 / S5 II 等机型支持）保存的是 10-bit HLG HDR
静态照片，但只有松下的 Windows 查看扩展和 Photoshop 插件能打开。手机打不开，HDR 就被
困在电脑里。

**HEIC 本质就是 HEVC 编码的 HEIF 容器**，而 `.HSP` 里面已经是一段 HEVC Main10 码流。
所以完全不需要解码再重新压缩：只要把码流重新装进 HEIC 容器，写对色彩标签，iPhone、
iPad、Android 上的相册就能直接打开，HDR 也能保留。

## 特性

- **真正无损** —— HEVC 码流逐字节拷贝，不解码、不二次压缩。
- **保留 HDR** —— 10-bit 4:2:0、BT.2020 原色、HLG 传输、BT.2020 非恒定亮度矩阵、limited range。
- **保留 EXIF** —— 机身、镜头、拍摄时间（含时区）、快门、光圈、ISO、焦距、作者、版权。
- **快** —— 2400 万像素约 10 毫秒一张。
- **零依赖** —— 纯 Python 标准库（3.8+），不需要 `pip install` 任何东西。
- **Windows 一键** —— 双击 `convert.bat`，或把文件夹拖上去。
- **中英双语命令行** —— 自动跟随系统语言，也可用 `--lang zh|en` 指定。

## 原理

```
.HSP（TIFF 容器）
├── IFD0 + ExifIFD  ──────────────► 重建成标准 EXIF
├── 64 KB 松下私有块（尺寸、统计信息，本工具不使用）
├── HEVC Main10 Annex B 码流 ─────► 逐个 NAL 搬进 HEIF 的 mdat
└── JPEG 预览图（IFD1/IFD2）       不使用

.HEIC（ISO/IEC 23008-12）
├── ftyp   heix / mif1 / miaf
├── meta   hvcC（从码流提取的 VPS/SPS/PPS）、colr nclx、ispe、pixi
├── mdat   原始图像分片
└── Exif   通过 cdsc 引用关联到主图
```

除了容器头、色彩描述和 EXIF 之外，工具不写任何像素数据。格式细节见
[docs/hsp-format.md](docs/hsp-format.md)。

## 环境要求

- Python **3.8+**（只用标准库，无需安装任何包）
- Windows：`convert.bat` 会自动寻找 `py -3`、`python`，或 `_tool\python\` 下的便携运行时
- macOS / Linux：直接 `python3 hsp2heic.py`

## 使用方法

### Windows 一键转换

```
panasonic-hsp-to-heic\
├── convert.bat
├── hsp2heic.py
├── raw_file\          ← 把 .HSP 放这里
└── samples\           ← 示例文件
```

1. 把 `.HSP` 文件放进 `raw_file\`（或任意文件夹）。
2. 双击 **`convert.bat`**。
3. 结果出现在 `raw_file\HEIC\`，原 `.HSP` 保留。

也可以把**整个文件夹**（或几个 `.HSP`）拖到 `convert.bat` 上：它会递归查找，
并在每个源文件夹旁边生成 `HEIC\` 子文件夹。

### 命令行

```bash
python hsp2heic.py                        # 转换 ./raw_file
python hsp2heic.py "D:\照片\码头"          # 转换指定文件夹
python hsp2heic.py a.HSP b.HSP            # 转换单个文件
```

| 参数 | 说明 |
|---|---|
| `--out DIR` | 全部输出到 `DIR`，不建 `HEIC\` 子文件夹 |
| `--force` | 覆盖已存在的 `.HEIC` |
| `--replace` | 转换成功后删除原 `.HSP`（谨慎） |
| `--no-recursive` | 不递归子文件夹 |
| `--lang zh\|en` | 指定命令行语言（默认跟随系统） |
| `-h`, `--help` | 显示帮助 |

## 输出文件

| 项目 | 内容 |
|---|---|
| 容器 | HEIC（`heix`，兼容 `mif1` + `miaf`） |
| 图像 | 5984 × 4000，10-bit，4:2:0（与相机码流一致） |
| 色彩 | BT.2020 / HLG / BT.2020 NC，limited range（`nclx` 9/18/9，full_range = 0） |
| 元数据 | 标准 EXIF（不含 MakerNote，见下方限制） |
| 体积 | 约为原 `.HSP` 减去内嵌 JPEG 预览图，2400 万像素约 2.6–4.5 MB |
| 速度 | 每张约 10 毫秒 |

## 兼容性

| 平台 | 表现 |
|---|---|
| iPhone / iPad（相册） | 原生打开；支持 HDR 的屏幕按 HDR 显示 |
| Windows 11（照片 / 资源管理器） | 需要 Microsoft Store 免费的“HEIF 图像扩展” |
| Android / Google Photos | 支持 HEIF 的相册都能打开，HDR 取决于设备 |
| 只支持 SDR 的查看器 | 由系统自动 tone mapping，不会发灰或全黑 |
| 微信等聊天软件 | 发送时可能被转成 SDR JPEG，原文件不受影响 |

## 限制

- 只支持 **4:2:0、10/12-bit 的 HLG** HEVC 码流，也就是 LUMIX HLG Photo 实际写出的格式。
- 松下的 **MakerNote** 不保留：它使用绝对文件偏移，换容器后无法安全搬迁。
- **GPS** 不保留（参考样片里本来也没有）。
- EXIF 的 `Orientation` 原样保留，但不写 HEIF 的 `irot` 盒；参考样片都是 orientation 1。
- 输出是标准的 **HLG HEIC**，不是 Apple / ISO 21496-1 的“增益图”HDR 照片。
  iOS 18 与 Android 15 的增益图 HDR 可以在后续版本里加。
- Windows 资源管理器的属性面板对 HEIC 只显示部分 EXIF；元数据本身在文件里
  （可用 exiftool、Lightroom 或 iPad 查看）。

## 验证情况

- 13 张样片，机身 **DC-S5（固件 2.8）**，镜头 APO-SUMMICRON-SL 35 mm f/2。
- 每张输出的 HEVC 分片与源 `.HSP` **逐字节相同**。
- 全部输出经 **libheif 1.23.6** 与 **Windows Imaging Component (WIC)** 解码验证。
- 色彩标签确认：`nclx: primaries=9, transfer=18, matrix=9, full_range=0`。

## 样片

[`samples/`](samples/README.md) 里有三组参考文件：

| 文件 | 场景 | 选它的原因 |
|---|---|---|
| `_PAN0301` | 黄昏码头 | 亮天空 + 深阴影 |
| `_PAN0766` | 室内逆光窗 | 极大动态范围 |
| `_PAN0976` | 湖光山色 | 平滑渐变，检查色彩过渡 |

照片采用 **CC BY-NC-SA 4.0** 协议，与代码的 MIT 协议分开。

## 格式笔记

`.HSP` 容器的逆向细节，以及本工具写出的 HEIF 结构，都记录在
[docs/hsp-format.md](docs/hsp-format.md)。

## 协议

- **代码** —— [MIT](LICENSE)，© 2026 Baizhi-Angelica。
- **样片** —— [CC BY-NC-SA 4.0](samples/LICENSE-CC-BY-NC-SA-4.0.txt)，© 2026 Baizhi-Angelica。

HEIC/HEVC 的专利授权与本仓库无关；本工具只重新封装你自己已经拥有的数据。

## 致谢

- [libheif](https://github.com/strukturag/libheif) 及其解码栈，用于验证输出。
- 以及此前所有记录过 HLG Photo 格式的人。
