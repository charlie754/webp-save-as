<#
.SYNOPSIS
  Packages the extension for Firefox (.xpi) or Chrome (unpacked folder + .zip).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1 -Chrome
  powershell -ExecutionPolicy Bypass -File scripts/package.ps1 -IncludeTests

.NOTES
  Firefox gets manifest.json (MV2) copied byte for byte. Chrome gets manifest.chrome.json (MV3)
  renamed to manifest.json, PNG icons instead of the SVG, and src/chrome/ instead of
  src/background.js. -IncludeTests adds the in-extension self-test used by
  test/browser/run-extension.mjs; the shipped packages never contain it.
#>
param(
  [switch]$IncludeTests,
  [switch]$Chrome,
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression          # ZipArchive, ZipArchiveMode
Add-Type -AssemblyName System.IO.Compression.FileSystem # ZipFile, ZipFileExtensions

$root = Split-Path -Parent $PSScriptRoot
$testOnly = @('test/selftest.html', 'test/selftest.js', 'test/selftest-boot.js')

if ($Chrome) {
  $manifestName = 'manifest.chrome.json'
  # No src/background.js: that is the Firefox MV2 background page.
  $shipped = @('icons', 'src/lib', 'src/chrome', 'src/options')
  $packageName = 'webp-save-as-chrome.zip'
  $unpackedName = 'chrome'
} else {
  $manifestName = 'manifest.json'
  $shipped = @('icons', 'src/lib', 'src/background.js', 'src/options')
  $packageName = if ($IncludeTests) { 'webp-save-as-test.xpi' } else { 'webp-save-as.xpi' }
  $unpackedName = $null
}

# ---------------------------------------------------------------- sanity checks

$manifestPath = Join-Path $root $manifestName
if (-not (Test-Path $manifestPath)) { throw "missing $manifestName" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
Write-Host ("packaging {0} {1} for {2} (manifest v{3})" -f `
  $manifest.name, $manifest.version, $(if ($Chrome) { 'Chrome' } else { 'Firefox' }), $manifest.manifest_version)

$referenced = @()
if ($manifest.background.scripts) { $referenced += $manifest.background.scripts }
if ($manifest.background.service_worker) { $referenced += $manifest.background.service_worker }
if ($manifest.options_ui.page) { $referenced += $manifest.options_ui.page }
foreach ($size in $manifest.icons.PSObject.Properties) { $referenced += $size.Value }
foreach ($rel in $referenced) {
  if (-not (Test-Path (Join-Path $root $rel))) {
    throw "$manifestName references a file that does not exist: $rel"
  }
}
Write-Host ("  {0} referenced files all present" -f $referenced.Count)

# ------------------------------------------------------------------- staging

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("webp-saveas-pkg-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  Copy-Item -Path $manifestPath -Destination (Join-Path $staging 'manifest.json') -Force

  foreach ($item in $shipped) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { throw "missing $item" }
    $destination = Join-Path $staging (Split-Path -Parent $item)
    if ((Split-Path -Parent $item)) { New-Item -ItemType Directory -Path $destination -Force | Out-Null }
    else { $destination = $staging }
    Copy-Item -Path $source -Destination $destination -Recurse -Force
  }

  if ($IncludeTests) {
    New-Item -ItemType Directory -Path (Join-Path $staging 'test') -Force | Out-Null
    foreach ($item in $testOnly) {
      $source = Join-Path $root $item
      if (-not (Test-Path $source)) { throw "missing $item (needed for -IncludeTests)" }
      Copy-Item -Path $source -Destination (Join-Path $staging 'test') -Force
    }
    if (-not $Chrome) {
      # Append the boot script so the self-test opens itself once the extension starts.
      $patched = Get-Content $manifestPath -Raw | ConvertFrom-Json
      $patched.background.scripts = @($patched.background.scripts) + 'test/selftest-boot.js'
      $json = $patched | ConvertTo-Json -Depth 20
      [System.IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Host '  + self-test files'
  }

  $outPath = Join-Path $root $OutDir
  New-Item -ItemType Directory -Path $outPath -Force | Out-Null

  # Chrome is loaded unpacked by the test runner and by "Load unpacked", so keep a folder too.
  if ($unpackedName) {
    $unpacked = Join-Path $outPath $unpackedName
    if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
    New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
    Copy-Item -Path (Join-Path $staging '*') -Destination $unpacked -Recurse -Force
    Write-Host ("  unpacked -> {0}" -f $unpacked)
  }

  $archive = Join-Path $outPath $packageName
  if (Test-Path $archive) { Remove-Item $archive -Force }

  # Not CreateFromDirectory: on .NET Framework it writes backslash separators, which is not a
  # valid zip path and not something a browser should be asked to tolerate. Add entries by hand.
  $zip = [System.IO.Compression.ZipFile]::Open($archive, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in (Get-ChildItem -Path $staging -Recurse -File | Sort-Object FullName)) {
      $relative = $file.FullName.Substring($staging.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $file.FullName, $relative,
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $zip.Dispose()
  }

  $check = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entries = $check.Entries | ForEach-Object { $_.FullName }
    if ($entries -notcontains 'manifest.json') { throw 'manifest.json is not at the archive root' }
    $bad = $entries | Where-Object { $_ -like '*\*' }
    if ($bad) { throw ("entries use backslashes: {0}" -f ($bad -join ', ')) }
    Write-Host ("  {0} entries, {1:N0} bytes" -f $entries.Count, (Get-Item $archive).Length)
    $entries | Sort-Object | ForEach-Object { Write-Host ("    {0}" -f $_) }
  } finally {
    $check.Dispose()
  }

  Write-Host ("built {0}" -f $archive)
  $archive
} finally {
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
