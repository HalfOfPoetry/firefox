# CHROME-8 交付产物

本分支**只承载 CHROME-8 的 Windows 交付产物与其校验值**，不是产品源码分支，请勿基于它开发。

产物由 `custom/stage2-integration` 的提交
`0b00b7873897e94e7229daa9e55d6012388dcae2` 构建得出（同源镜像分支
`custom/win-build-chain-merged`，HEAD 相同）。

## 为什么是分片的

GitHub 单文件硬上限 100 MB，`firefox-160.0a1.en-US.win64.zip` 原始 133.84 MB，
直接入库会被服务端拒收。因此在线 zip 与 installer 都按 **45 MiB** 切分为
`*.part.NN`，再把分片拼回原文件即可（拼回后 SHA-256 与下表完全一致，已在本机验证）。

## 取用方式

```bash
git clone --depth 1 --single-branch --branch chrome-8-delivery \
  https://github.com/HalfOfPoetry/firefox.git chrome8-delivery
cd chrome8-delivery/delivery

sha256sum -c SHA256SUMS.txt          # 先校验分片本身

cat zip.part.* > firefox-160.0a1.en-US.win64.zip
cat exe.part.* > firefox-160.0a1.en-US.win64.installer.exe

sha256sum firefox-160.0a1.en-US.win64.zip firefox-160.0a1.en-US.win64.installer.exe
```

拼回后应得到：

| 成品 | 大小 (B) | SHA-256 |
|---|---|---|
| `firefox-160.0a1.en-US.win64.zip` | 140339109 | `4ac70df7cea210ff3071b6f251f5f773a4ea3b8b310f801b05ece6e58a2be1b4` |
| `firefox-160.0a1.en-US.win64.installer.exe` | 92027540 | `a887b6890dfa116d3df54426746f3f3b3dc9f2f656b86759b43346b64c9451ba` |

Windows 上等价的拼接命令（PowerShell）：

```powershell
Get-Content zip.part.* -Encoding Byte -Raw | Set-Content firefox-160.0a1.en-US.win64.zip -Encoding Byte
```

（或 `cmd /c copy /b zip.part.00+zip.part.01+zip.part.02 out.zip`。）

`firefox-window.png` 是本机启动验证时抓取的窗口截图，侧边栏底部可见 Images 工具图标。

## 分片校验值

见同目录 `SHA256SUMS.txt`。

构建口径、复现命令与已知限制见 CHROME-8 的结论评论，以及源分支上的
`build/win-custom/README.md`。