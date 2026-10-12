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

这两个文件是构建链的全部。任何额外的手工步骤都属于缺陷，应该改进本目录而不是写进文档。

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
| **安装包（NSIS installer / MSI）** | **范围外** | `mach package` 产出的是 zip 绿色包。安装包需要 `--enable-installer` 并引入 NSIS，属另一个口径 |
| **更新包 / MAR** | **范围外** | 需要 update channel 与签名密钥 |

## 5. 实测数据

见 CHROME-7 的结论评论（本目录随构建链改动一起交付，实测数字在评论里更新）。
实测口径：同一台机器、冷 objdir、`mach build` 到完成。

## 6. 已知限制与坑

1. **非英文 Windows 必须 `PYTHONUTF8=1`**。见 3.3。这是构建机上真实踩到并已修掉的问题，
   不是预防性建议。
2. **Windows SDK 路径不能有空格**。构建系统会对含空格的路径调 `GetShortPathNameW`，
   要求它返回 8.3 短名；若卷上没启用 8.3 名称生成，会硬失败：
   `GetShortPathName returned a long path name`。本构建机 `C:` 正是这种情况，解法见下。
3. **MSVC / SDK 用本机安装的**，不用 Mozilla CI 的 `vs` 工具链。`--enable-bootstrap`
   会尝试拉 Mozilla 的打包 VS（约 1.4 GB），但它**适用的是 8.3 名称可用的英文系统**；
   若想省掉这 1.4 GB，见下。
4. **`mach build faster` 只有在 objdir 已经 configure 过、且改动不涉及 C++/Rust 时才快**。
   定制层满足这个条件；一旦改了 `moz.build` / `jar.mn` 之外的构建定义，要回落到全量。

### 关于第 2、3 条的处理

本构建机（zh-CN Windows 10，`C:` 未启用 8.3 名称）上，上游的自动工具链获取会撞上
第 2 条。已在构建链里用**不受影响的方式**解决：

- 源码与 objdir 放在 `D:`（`D:\ff-src`），工具链状态目录也放 `D:`（`D:\mozbuild-state`）。
- Windows SDK 通过一个不含空格、且不会触发短名转换的入口暴露给构建系统：把
  `C:\Program Files (x86)\Windows Kits\10` 做一个目录联接（junction）到 `C:\winsdk10`，
  并设置 `WINDOWSSDKDIR=C:\winsdk10`。`GetShortPathNameW` 对 `C:\winsdk10` 原样返回，
  不触发「路径含空格」的失败分支。

  创建联接（无需管理员）：

  ```powershell
  New-Item -ItemType Junction -Path "C:\winsdk10" -Target "C:\Program Files (x86)\Windows Kits\10"
  ```

  这是**构建机环境准备**，不是源码改动；脚本里用 `-WindowsSdkDir` 参数传入：

  ```powershell
  .\build\win-custom\build.ps1 -Step all -StatePath D:\mozbuild-state -WindowsSdkDir C:\winsdk10
  ```

5. **`multica repo checkout` 在超大仓库上会超时**。本仓库 `main` 的 blob 量约 1.4 GB，
   托管 daemon 的 checkout 有 5 分钟请求超时，拉不完就被中断。改用直连
   `git clone --depth 1` 到 `D:` 盘。这是工具限制，不是本构建链的问题，但换机器复现时
   会遇到，所以记在这里。

## 7. 定制补丁序列的重放（D-1 约束）

定制层按 CHROME-11 的决定走「独立定制分支 + 补丁序列」。上游升级时的重放顺序：

1. `main` 跟随上游快进；
2. 从 `main` 新建定制分支；
3. 按 commit 顺序 `git cherry-pick` 定制提交（每个定制点独立成 commit，新增文件与
   注册型 hunk 分开）。

本目录（`build/win-custom/`）是构建链的定制提交，与产品功能改动分开，能独立重放。