<#
.SYNOPSIS
  Reproducible Windows x86_64 build of the customized Firefox.

.DESCRIPTION
  Drives the whole chain: environment setup, bootstrap, configure, build and
  package. Every path is derived from the checkout location, so the script can
  be run from any clone on any machine without editing it.

  Run it from a plain PowerShell prompt. It does NOT need the MozillaBuild
  shell to be started manually (it passes MOZILLABUILD through instead), but
  MozillaBuild must be installed.

.PARAMETER MozillaBuild
  MozillaBuild installation root. Defaults to $env:MOZILLABUILD, then
  C:\mozilla-build.

.PARAMETER StatePath
  Where mach keeps its shared state (toolchains, virtualenvs). Defaults to
  $env:MOZBUILD_STATE_PATH, then <checkout>\..\mozbuild-state. Keep this OFF
  the system drive; it grows to several GB.

.PARAMETER Step
  Which steps to run: bootstrap, configure, build, package, all (default).

.PARAMETER Jobs
  Parallel compile jobs. Defaults to the machine's logical processor count.

.EXAMPLE
  .\build.ps1 -Step all
.EXAMPLE
  .\build.ps1 -Step build -Jobs 8
#>
[CmdletBinding()]
param(
    [ValidateSet('bootstrap', 'configure', 'build', 'package', 'all')]
    [string]$Step = 'all',

    [string]$MozillaBuild = $(if ($env:MOZILLABUILD) { $env:MOZILLABUILD } else { 'C:\mozilla-build' }),

    [string]$StatePath = $(if ($env:MOZBUILD_STATE_PATH) { $env:MOZBUILD_STATE_PATH } else { '' }),

    # Only needed on hosts whose Windows SDK lives under a path containing a
    # space AND whose volume has 8.3 name generation disabled -- see README.md
    # section 6. Point this at a space-free junction of the SDK root.
    [string]$WindowsSdkDir = $env:WINDOWSSDKDIR,

    [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'

# --- Locate the checkout --------------------------------------------------
# This script lives at <topsrcdir>\build\win-custom\build.ps1.
$TopSrcDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if (-not $StatePath) {
    $StatePath = Join-Path (Split-Path $TopSrcDir -Parent) 'mozbuild-state'
}

if ($Jobs -le 0) {
    $Jobs = [Environment]::ProcessorCount
}

$Mozconfig = Join-Path $TopSrcDir 'build\win-custom\mozconfig.win64'

# --- Preconditions --------------------------------------------------------
if (-not (Test-Path $MozillaBuild)) {
    throw "MozillaBuild not found at '$MozillaBuild'. Install it from https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe or pass -MozillaBuild <path>."
}
if (-not (Test-Path $Mozconfig)) {
    throw "mozconfig not found at '$Mozconfig'."
}
# The build system does not support spaces in either path.
foreach ($p in @($TopSrcDir, $MozillaBuild)) {
    if ($p -match ' ') { throw "Path contains a space, which the Firefox build system does not support: '$p'" }
}

Write-Host "topsrcdir   : $TopSrcDir"
Write-Host "mozconfig   : $Mozconfig"
Write-Host "mozillabuild: $MozillaBuild"
Write-Host "state path  : $StatePath"
Write-Host "jobs        : $Jobs"

# --- Environment ----------------------------------------------------------
$env:MOZILLABUILD = $MozillaBuild
$env:MOZBUILD_STATE_PATH = $StatePath
$env:MOZCONFIG = $Mozconfig
$env:MOZ_OBJDIR = Join-Path $TopSrcDir 'obj-custom-win64'
$env:MOZ_MAKE_FLAGS = "-j$Jobs"

if ($WindowsSdkDir) {
    $env:WINDOWSSDKDIR = $WindowsSdkDir
}

# On non-English Windows (this repo's build host is zh-CN), Python otherwise
# decodes source files with the ANSI code page. taskgraph loading then dies on
# a UnicodeDecodeError, which silently disables --enable-bootstrap's toolchain
# fetch and surfaces as a missing clang/vs toolchain much later. Forcing UTF-8
# is required, not cosmetic.
$env:PYTHONUTF8 = '1'

# mach needs MozillaBuild's msys2 tooling on PATH. Prepending (rather than
# inheriting) keeps a stray system msys2/cygwin from shadowing it.
$env:PATH = "$MozillaBuild\bin;$MozillaBuild\msys2\usr\bin;$env:PATH"

# The rust toolchain downloaded by `mach bootstrap` lands in ~/.cargo/bin,
# which is not necessarily on PATH for a fresh shell.
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# --- Steps ----------------------------------------------------------------
function Invoke-Mach {
    param([string[]]$Arguments)
    Write-Host "`n>>> mach $($Arguments -join ' ')" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $TopSrcDir
    try {
        & python mach @Arguments
        if ($LASTEXITCODE -ne 0) { throw "mach $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
        $sw.Stop()
    }
    Write-Host ("<<< done in {0:n1} min" -f $sw.Elapsed.TotalMinutes) -ForegroundColor Green
}

if ($Step -in @('bootstrap', 'all')) {
    # Installs rust (if missing) and the pinned clang/rust toolchains fetched
    # from Mozilla CI. Safe to re-run: it is a no-op once satisfied.
    Invoke-Mach @('bootstrap', '--application-choice=browser')
}

if ($Step -in @('configure', 'all')) {
    Invoke-Mach @('configure')
}

if ($Step -in @('build', 'all')) {
    Invoke-Mach @('build')
}

if ($Step -in @('package', 'all')) {
    # Produces the zip under $MOZ_OBJDIR\dist\.
    Invoke-Mach @('package')
    Write-Host "`nArtifacts in $env:MOZ_OBJDIR\dist" -ForegroundColor Yellow
    Get-ChildItem $env:MOZ_OBJDIR\dist -Include *.zip, *.exe, *.msi -Recurse -ErrorAction SilentlyContinue |
        Select-Object FullName, @{n = 'SizeMB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
        Format-Table -AutoSize
}

Write-Host "`nDone." -ForegroundColor Green