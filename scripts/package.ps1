<#
.SYNOPSIS
  Packages the extension into a .xpi (a plain zip with manifest.json at the root).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1 -IncludeTests

.NOTES
  -IncludeTests adds the in-extension self-test and appends its boot script to
  background.scripts, for test/browser/run-extension.mjs. The shipped package never
  contains it, and its manifest.json is copied byte for byte.
#>
param(
  [switch]$IncludeTests,
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression          # ZipArchive, ZipArchiveMode
Add-Type -AssemblyName System.IO.Compression.FileSystem # ZipFile, ZipFileExtensions

$root = Split-Path -Parent $PSScriptRoot
$shipped = @('manifest.json', 'icons', 'src')
$testOnly = @('test/selftest.html', 'test/selftest.js', 'test/selftest-boot.js')

# ---------------------------------------------------------------- sanity checks

$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
Write-Host ("packaging {0} {1} (manifest v{2})" -f $manifest.name, $manifest.version, $manifest.manifest_version)

$referenced = @()
$referenced += $manifest.background.scripts
$referenced += $manifest.options_ui.page
foreach ($size in $manifest.icons.PSObject.Properties) { $referenced += $size.Value }
foreach ($rel in $referenced) {
  if (-not (Test-Path (Join-Path $root $rel))) {
    throw "manifest.json references a file that does not exist: $rel"
  }
}
Write-Host ("  {0} referenced files all present" -f $referenced.Count)

# ------------------------------------------------------------------- staging

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("webp-saveas-pkg-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  foreach ($item in $shipped) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { throw "missing $item" }
    Copy-Item -Path $source -Destination $staging -Recurse -Force
  }

  if ($IncludeTests) {
    New-Item -ItemType Directory -Path (Join-Path $staging 'test') -Force | Out-Null
    foreach ($item in $testOnly) {
      $source = Join-Path $root $item
      if (-not (Test-Path $source)) { throw "missing $item (needed for -IncludeTests)" }
      Copy-Item -Path $source -Destination (Join-Path $staging 'test') -Force
    }
    # Append the boot script so the self-test opens itself once the extension starts.
    $patched = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $patched.background.scripts = @($patched.background.scripts) + 'test/selftest-boot.js'
    $json = $patched | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  + self-test files and background boot script'
  }

  $outPath = Join-Path $root $OutDir
  New-Item -ItemType Directory -Path $outPath -Force | Out-Null
  $name = if ($IncludeTests) { 'webp-save-as-test.xpi' } else { 'webp-save-as.xpi' }
  $xpi = Join-Path $outPath $name
  if (Test-Path $xpi) { Remove-Item $xpi -Force }

  # Not CreateFromDirectory: on .NET Framework it writes backslash separators, which is not a
  # valid zip path and not something Firefox should be asked to tolerate. Add entries by hand.
  $archive = [System.IO.Compression.ZipFile]::Open($xpi, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in (Get-ChildItem -Path $staging -Recurse -File | Sort-Object FullName)) {
      $relative = $file.FullName.Substring($staging.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $file.FullName, $relative,
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }

  # Firefox reads manifest.json from the archive root with forward-slash paths.
  $zip = [System.IO.Compression.ZipFile]::OpenRead($xpi)
  try {
    $entries = $zip.Entries | ForEach-Object { $_.FullName }
    if ($entries -notcontains 'manifest.json') { throw 'manifest.json is not at the archive root' }
    $bad = $entries | Where-Object { $_ -like '*\*' }
    if ($bad) { throw ("entries use backslashes: {0}" -f ($bad -join ', ')) }
    Write-Host ("  {0} entries, {1:N0} bytes" -f $entries.Count, (Get-Item $xpi).Length)
    $entries | Sort-Object | ForEach-Object { Write-Host ("    {0}" -f $_) }
  } finally {
    $zip.Dispose()
  }

  Write-Host ("built {0}" -f $xpi)
  $xpi
} finally {
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
