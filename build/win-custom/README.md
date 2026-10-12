# Windows 构建链（定制 Firefox）

本目录是**定制层**的一部分，不属于上游 Mozilla 源码。它把「在这台机器上怎么把定制
Firefox 编出来」固化成可追踪的文件 + 可重复执行的脚本，任何人照本目录的步骤都能在
另一台 Windows 机器上复现同样的产物。

> 背景：定制内容本身（侧边栏图片资源面板 + page actor）是纯 chrome 侧
> JS/HTML/CSS/FTL 改动，不含 C++ 与 Rust。但交付需要**自包含**的产物，所以默认走
> 全量构建而不是 artifact（预编译二进制）构建。

## 1. 目录内容

| 文件 | 作用 |
|---|---|
| `mozconfig.win64` | 构建口径的唯一来源：目标平台、objdir、工具链获取方式、构建形态 |
| `build.ps1` | 驱动 bootstrap → configure → build → package，路径全部从 checkout 位置推导 |

另有两个不在本目录的辅助脚本，用于在工具链下载被单连接限速或挂住时并发预取
（见第 6 节）—— 它们不是构建的必经步骤，只在慢线路上才需要：

- `tools/build-prefetch-toolchain.py`：并发拉取单个 artifact。
- `tools/build-autoprefetch-toolchains.py`：从 `config.log` 解析出 configure 需要的全部
  工具链，逐个并发预取；`mach configure` 失败一次就多暴露一个，多跑几轮即可收敛。

`build/win-custom/` 下的这两个文件是构建口径与流程的全部来源。任何额外的手工步骤都属于
缺陷，应该改进这里而不是写进文档。

## 2. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Windows | 10 或 11 x64 | 上游 Tier-1 支持范围 |
| MozillaBuild | **4.2.1 或更新** | https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe ，默认装到 `C:\mozilla-build` |
| Visual Studio | 2022，含 **「使用 C++ 的桌面开发」** 工作负载 | 需要 `VC.Tools.x86.x64`、ATL/MFC（`atlmfc` 头与库）、以及 Windows 10/11 SDK。构建链只用它的链接器与部分工具，编译器用 Mozilla 的 clang |
| Python | 3.10 – 3.13 | mach 自身的版本约束；`py` 启动器或 PATH 上的 `python` 均可 |
| 网络 | 可达 `github.com`、`ftp.mozilla.org`、`firefox-ci-tc.services.mozilla.com`、`download.visualstudio.microsoft.com`、`crates.io` | 首次构建需下载工具链与依赖 |
| 磁盘 | 见第 5 节实测数字 | 源码 + objdir + 工具链状态目录三者相加 |
| 路径 | **不能含空格** | 源码目录与 MozillaBuild 目录都适用，这是 Firefox 构建系统的硬约束 |

**Windows Defender 排除**：把源码目录、objdir、`%USERPROFILE%\.mozbuild`（或你的
`MOZBUILD_STATE_PATH`）加入排除列表。不排除会显著拖慢构建，偶发「文件找不到」的
失败。

## 3. 复现步骤

### 3.1 取源码

```powershell
git clone https://github.com/HalfOfPoetry/firefox.git D:\ff-src
cd D:\ff-src
git checkout <定制分支>
```

### 3.2 一条命令构建

```powershell
.\build\win-custom\build.ps1 -Step all -StatePath D:\mozbuild-state
```

脚本会依次执行 bootstrap、configure、build、package，并把每一步的耗时打出来。
首次运行会下载 Mozilla 的 clang/VS 工具链与 rust（数 GB），之后的运行会复用缓存。

分步执行（调试时用）：

```powershell
.\build\win-custom\build.ps1 -Step bootstrap
.\build\win-custom\build.ps1 -Step configure
.\build\win-custom\build.ps1 -Step build -Jobs 8
.\build\win-custom\build.ps1 -Step package
```

### 3.3 不用脚本时

脚本只做三件事：设环境变量、调 `mach`。手工等价操作：

```bat
set MOZILLABUILD=C:\mozilla-build
set MOZBUILD_STATE_PATH=D:\mozbuild-state
set MOZCONFIG=D:\ff-src\build\win-custom\mozconfig.win64
set PYTHONUTF8=1
set PATH=%MOZILLABUILD%\bin;%MOZILLABUILD%\msys2\usr\bin;%PATH%
cd /d D:\ff-src
python mach build
```

`PYTHONUTF8=1` **不是可选的美化项**：在非英文 Windows（本仓库的构建机是 zh-CN）上，
Python 默认用 ANSI 代码页解码源码文件，加载 taskgraph 时抛 `UnicodeDecodeError`，
其后果是 `--enable-bootstrap` 的工具链获取被静默跳过，最后表现为找不到 clang / VS
工具链。见第 6 节。

### 3.4 跑起来看看

```powershell
cd D:\ff-src
python mach run
```

## 4. 构建口径（`mozconfig.win64` 每一项的理由）

| 配置 | 取值 | 理由 |
|---|---|---|
| `--enable-project` | `browser` | 由 `browser/config/mozconfig` 带出，是 Firefox 桌面的标准入口 |
| `--target` | `x86_64-pc-windows-msvc` | 本期只做 Win10/11 x64。**arm64 不在本期范围**（见第 7 节） |
| `--enable-bootstrap` | 开 | 让 configure 从 Mozilla CI 拉取**固定 revision** 的 clang / VS 工具链。这是「另一台机器可复现」的关键：构建不再依赖构建机上恰好装了什么版本的 clang |
| `--disable-tests` | 开 | 测试不是交付物，关掉能显著缩短构建、缩小 objdir |
| `MOZ_OBJDIR` | `<topsrcdir>/obj-custom-win64` | 落在源码树内，被仓库的 `/obj*/` 规则忽略，整个构建自包含在一个目录下 |

### 本期范围 / 范围外

| 项 | 状态 | 说明 |
|---|---|---|
| Windows x64 全量构建 | **本期** | |
| 前端增量构建（`mach build faster`） | **本期** | 改动只有 JS/HTML/CSS 时用它迭代，秒级到分钟级 |
| `mach package` 出 zip | **本期** | Stage 3 出包用 |
| **代码签名** | **范围外** | 默认 branding 是 `unofficial`（`browser/confvars.sh`），本地产物可直接运行、不需要签名。签名只在对外分发时才必需，且需要人类提供证书 |
| **Windows arm64** | **范围外** | 需要人类决策是否立项；本期工具链与验证都按 x64 做 |
| **安装包（NSIS installer / MSI）** | **本期** | 打包阶段会一并产出 `firefox-*.installer.exe`（见第 5 节产物表），无需额外开关；`--enable-installer` 与 MSI 属另一个口径，未启用 |
| **更新包 / MAR** | **范围外** | 需要 update channel 与签名密钥 |

## 5. 实测数据

实测机器：Intel i5-10400（6 核 12 线程）/ 31.8 GB RAM / Windows 10 19045 / 源码与 objdir
均在 `D:`（机械盘，非 dev drive）。`mach` 并行度 `-j12`。

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 下载 + 安装全部工具链 | **约 3.5 小时** | 受线路限制，见第 6 节第 6 条；换宽带环境会短得多 |
| `mach configure`（工具链已就绪） | **1 分钟** | 含解析 2549 个 moz.build、生成 20443 个 build config |
| `mach build`（冷 objdir，全量） | **111 分钟** | 635 条编译器警告，0 错误 |
| `mach build`（无改动的二次运行） | **21 分钟** | 主要是重新链接与重打包，与是否改前端代码无关 |
| `mach package`（出 zip + installer.exe） | **2.5 分钟** | 复用上一步的 objdir |

| 磁盘占用 | 实测 |
|---|---|
| 源码树（含所有 blobs 的完整 checkout） | **30.0 GB** |
| objdir（`obj-custom-win64`） | **26.7 GB** |
| 工具链状态目录（`MOZBUILD_STATE_PATH`） | **12.2 GB** |
| **合计** | **约 69 GB** |

其中工具链状态目录的构成：Mozilla 打包 VS 6.8 GB、clang 3.9 GB、下载缓存 1.2 GB、
windows-rs 111 MB、node 99 MB，其余均为个位数 MB。

> 评估阶段（CHROME-4）估的是「全量构建需 40–60 GB」。实测**更高**：源码 30 GB 加 objdir
> 26.7 GB 就已经越过 60 GB 的一半，再加上 12 GB 工具链状态目录，总量约 69 GB。换机器时
> 按 **≥80 GB 可用空间**准备，且**必须避开系统盘**（评估时 `C:` 只剩 29 GB，本机因此
> 全程用 `D:`）。

### 产物（`<objdir>/dist/`）

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `firefox-160.0a1.en-US.win64.zip` | 140,339,109 B | `4ac70df7cea210ff3071b6f251f5f773a4ea3b8b310f801b05ece6e58a2be1b4` |
| `firefox-160.0a1.en-US.win64.installer.exe` | 92,027,540 B | `a887b6890dfa116d3df54426746f3f3b3dc9f2f656b86759b43346b64c9451ba` |

构建配置里**没有** `--enable-installer`，但打包阶段仍然产出了 `.installer.exe`（NSIS
自解压包，由仓库内 `browser/installer` 的默认流程生成）。这两个是本 issue 的**构建验证
产物**，不是 Stage 3 要交付的正式产物 —— 按本 issue 边界，产物交付与归档属 Stage 3 / 5。

**定制改动确认已进产物**：解包 zip 里的 `firefox/browser/omni.ja`，可见 6 个定制文件全部
就位 —— `actors/ImageResourceChild.sys.mjs`、`actors/ImageResourceParent.sys.mjs`、
`chrome/browser/content/browser/sidebar/sidebar-images{, -filter}.mjs`、
`sidebar-images.html`、`sidebar-images.css`。这证明构建链确实把 CHROME-6 的改动编进了产物。

## 6. 已知限制与坑

1. **非英文 Windows 必须 `PYTHONUTF8=1`**。见 3.3。这是构建机上真实踩到并已修掉的问题，
   不是预防性建议。
2. **`mach build faster` 只有在 objdir 已经 configure 过、且改动不涉及 C++/Rust 时才快**。
   定制层满足这个条件；一旦改了 `moz.build` / `jar.mn` 之外的构建定义，要回落到全量。
   注意**无改动的 `mach build` 仍需约 21 分钟**（主要是重链接 + 重打包），所以迭代前端
   代码时用 `faster`，不要用 `build`。
3. **本机的 Windows SDK 装在含空格的路径下，且 `C:` 未启用 8.3 短名**。这在构建早期会
   导致一次硬失败：构建系统对 `C:\Program Files (x86)\Windows Kits\10` 调
   `GetShortPathNameW`（`build/moz.configure/util.configure:140`），拿到仍是长名的结果后
   报 `GetShortPathName returned a long path name`。
   **不需要处理** —— 见下，`--enable-bootstrap` 拉来的 Mozilla VS 工具链自带一套 SDK，
   configure 会优先用它，根本不会走到本机 SDK 那条路径。
4. **`--enable-bootstrap` 会下载约 7 GB 工具链**（clang 3.9 GB + Mozilla 打包 VS 6.8 GB，
   解压后）。这是「另一台机器可复现」的代价：构建不再依赖构建机上恰好装了什么。

### 关于本机 SDK 路径（第 3 条）的实际结论

一开始怀疑必须给 SDK 做一个不含空格的目录联接（junction）绕开 8.3 问题。**实测证明不必**：
只要 `--enable-bootstrap` 的 VS 工具链装好了，configure 就走 `winsysroot` 分支，SDK 取自
`<state>/vs/Windows Kits/10`，全程不碰注册表里那条含空格的路径。构建脚本里因此**没有**
任何 SDK 路径参数。

如果哪天关掉 `--enable-bootstrap` 改用本机 VS/SDK，这个坑才会重新出现，届时的绕法是：

```powershell
New-Item -ItemType Junction -Path "C:\winsdk10" -Target "C:\Program Files (x86)\Windows Kits\10"
$env:WINDOWSSDKDIR = 'C:\winsdk10'
```

5. **`multica repo checkout` 在超大仓库上会超时**。本仓库 `main` 的 blob 量约 1.4 GB，
   托管 daemon 的 checkout 有 5 分钟请求超时，拉不完就被中断。改用直连
   `git clone --depth 1` 到 `D:` 盘。这是工具限制，不是本构建链的问题，但换机器复现时
   会遇到，所以记在这里。

6. **工具链下载可能极慢或直接挂住**。`--enable-bootstrap` 抓的 clang 工具链约 1 GB，
   由 `mozbuild.artifact_cache.ArtifactCache` 下载，它用**单条流式连接且不给这条连接设
   读超时**：

   ```python
   with closing(session.get(url, stream=True)) as response:
       for chunk in response.iter_content(chunk_size):
   ```

   在到 artifact CDN 慢的线路上，表现是吞吐只有几十 KB/s、或者干脆卡在某个百分比上
   永远不动，既不报错也无法推进（本构建机上实测：单连接 60–100 KB/s 且反复停滞，
   同 URL 用 16 路 range 并发约 1.2 MB/s）。

   **绕过办法**：用 `tools/build-prefetch-toolchain.py` 先并发把 artifact 拉进 mach 的
   artifact 缓存目录，之后 `mach configure` 会发现缓存命中、跳过自己的下载。更省事的
   做法是直接跑 `tools/build-autoprefetch-toolchains.py`，它一次把 configure 需要的**全部**
   工具链（实测 16 个）都预取好。两个脚本都接受「artifact URL + 缓存目录」两个参数，
   缓存目录就是 mach 输出里 `Downloading artifact to local cache:` 那一行的父目录，通常
   是 `<MOZBUILD_STATE_PATH>/toolchains`：

   ```powershell
   python tools\build-autoprefetch-toolchains.py `
       D:\ff-src\obj-custom-win64\config.log `
       D:\mozbuild-state\toolchains
   ```

   脚本可断点续传：再跑一次会跳过已完成的 1 MiB 分片。它写出的文件名与
   `ArtifactCache` 的命名规则逐字一致（`sha256(url)[:16] + "-" + basename`），源文件
   与 mach 自己下载的完全相同，只是传输方式不同。

## 7. 定制补丁序列的重放（D-1 约束）

定制层按 CHROME-11 的决定走「独立定制分支 + 补丁序列」。上游升级时的重放顺序：

1. `main` 跟随上游快进；
2. 从 `main` 新建定制分支；
3. 按 commit 顺序 `git cherry-pick` 定制提交（每个定制点独立成 commit，新增文件与
   注册型 hunk 分开）。

本目录（`build/win-custom/`）是构建链的定制提交，与产品功能改动分开，能独立重放。