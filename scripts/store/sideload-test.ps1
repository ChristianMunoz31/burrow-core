<#
.SYNOPSIS
  Sideload test of the Burrow MSIX local-test package: proves the Store build keeps the user's data in the real
  data folder (not in the package's virtualised LocalCache), and that uninstalling leaves it alone. Two data
  locations, chosen by the package (docs/MICROSOFT_STORE.md): 'appdata' = the real %APPDATA%\Burrow, 'userprofile'
  = %USERPROFILE%\Burrow Data (the build made with --data-location userprofile, for when Partner Center refuses
  rescap:unvirtualizedResources; the direct data in %APPDATA%\Burrow must then stay untouched).

.DESCRIPTION
  Run this yourself in an ELEVATED PowerShell 5.1 window. By default it is a DRY RUN: it prints every step it
  would do and changes nothing (no backup, no certificate, no install, no launch, no report file). Add -Run to
  apply it. Nothing here runs from CI and nothing is uploaded anywhere.

  Steps with -Run:
    a. Preflight: admin, Burrow not running, package not already installed, bundle signature subject equals the
       certificate subject and the publisher in config/msstore.json, package identity name is as expected.
       Userprofile mode also needs %USERPROFILE%\Burrow Data to be missing, empty, or a folder with a valid
       .burrow-data.json marker (checked like the app does: exact case, formatVersion the integer 1, no byte order
       mark, strict UTF-8). A folder that exists without the marker (or is a file, a link, a junction, a dangling link,
       another reparse point, or cannot be read) is NOT a Burrow data folder: the preflight FAILS and the script never
       reads it for a backup or touches it.
    b. Back up the data folder (%APPDATA%\Burrow, or %USERPROFILE%\Burrow Data in userprofile mode) to
       %USERPROFILE%\BurrowBackup-<stamp>, verify the copy (file count, size and the burrow.db SHA256 against the
       BEFORE hash; any failure stops the run before the certificate and install), take the BEFORE snapshot.
       The backup refuses a folder that contains a .git folder, more than 5000 files or more than 1 GB unless -Force.
       In userprofile mode the direct data (%APPDATA%\Burrow) is backed up and verified the same way (to
       BurrowDirect in the same backup folder) and snapshotted: it must come out unchanged.
       %APPDATA%\Burrow Dev is only noted (never copied, never touched).
    c. Trust the test certificate in Cert:\LocalMachine\TrustedPeople (needs admin; see the note in the code).
    d. Add-AppxPackage the bundle and read the real PackageFamilyName.
    e. Launch Burrow from shell:AppsFolder, wait for Burrow.exe and burrow-server.exe, wait -WaitSeconds, then
       (interactive only, skip with -NoPrompt) ask you to change something and make a manual backup.
    f. AFTER snapshot: PASS when no Burrow data files sit under the package's LocalCache and new or changed
       files appear in the real data folder. Also looks for the burrow-distribution=store marker (and
       burrow-data-location=<mode>) in the logs. Userprofile mode also needs the server log in
       %USERPROFILE%\Burrow Data\logs and %APPDATA%\Burrow byte-for-byte unchanged (files, sizes, times, burrow.db SHA256).
    g. Close Burrow (CloseMainWindow, Stop-Process only after a timeout), Remove-AppxPackage, confirm the package
       and its Packages folder are gone and the real data and backups are still there (userprofile mode: the
       direct data is still unchanged too).
    h. Remove the certificate from LocalMachine\TrustedPeople (only if this script added it). -RemoveSigningCert
       also removes the matching certificate from Cert:\CurrentUser\My.
    i. try/finally: the package and certificate are cleaned up even when a step fails. A text and a JSON report
       are written beside the bundle (or at -ReportPath) with every check, path, snapshot and restore steps.

  Exit code 0 when every check passes, 1 otherwise.

.PARAMETER Bundle
  The .msixbundle to install. Default: the newest %LOCALAPPDATA%\burrow-release\store\*-localtest\Burrow_*.msixbundle.
.PARAMETER Cer
  The public test certificate. Default: BurrowLocalTest.cer in the same folder as the bundle.
.PARAMETER ReportPath
  Text report path (the JSON report uses the same name with .json). Default: beside the bundle.
.PARAMETER WaitSeconds
  How long to let the app settle after it starts (opens the database, may run the daily automatic backup).
.PARAMETER Run
  Apply the steps. Without it nothing is changed.
.PARAMETER NoPrompt
  Do not stop to ask you to make a change and a manual backup in the app.
.PARAMETER RemoveSigningCert
  Also remove the signing certificate from Cert:\CurrentUser\My at the end.
.PARAMETER AllowSchemaUpgrade
  Appdata mode only. Required when the bundle's app version is newer than the installed direct Burrow (or that
  version cannot be read) and a data folder exists. The Store test build opens the real %APPDATA%\Burrow\burrow.db
  and may migrate it forward, after which the older direct app refuses the file (db_too_new). Restoring the backup
  (steps in the report) is the way back. Not needed in userprofile mode: that build never opens the AppData database
  (an import copies it and migrates only the copy), and the script verifies %APPDATA%\Burrow stays unchanged.
.PARAMETER Force
  Lifts the safety limits of the backup step (see Invoke-VerifiedBackup): a folder with a .git folder, more than
  5000 files or more than 1 GB is refused without it. Never needed for a real Burrow data folder; it exists so a
  large but genuine data folder can still be tested. It does NOT lift the ownership check below.
.PARAMETER ProfileRoot
  For dry runs and tests only: the folder that holds 'Burrow Data' (userprofile mode) and the BurrowBackup-<stamp> folders.
  Default: %USERPROFILE%. Only the userprofile folder and the backups move; %APPDATA% is not affected. -Run with a
  -ProfileRoot that is not %USERPROFILE% FAILS the preflight.
.PARAMETER DataLocation
  appdata or userprofile. Default: read from the bundle manifest (no rescap:unvirtualizedResources capability
  means userprofile). When you pass it and the bundle says the other one, the preflight FAILS (no mismatch is
  allowed). Without -Bundle, the default bundle search follows it: appdata looks in *-localtest, userprofile in
  *-localtest-userprofile.

.EXAMPLE
  .\scripts\store\sideload-test.ps1            # dry run
  .\scripts\store\sideload-test.ps1 -Run       # apply, in an elevated PowerShell
  .\scripts\store\sideload-test.ps1 -DataLocation userprofile            # dry run of the userprofile package
  .\scripts\store\sideload-test.ps1 -DataLocation userprofile -Run       # apply it, in an elevated PowerShell
#>
[CmdletBinding()]
param(
  [string]$Bundle,
  [string]$Cer,
  [string]$ReportPath,
  [ValidateRange(0, 600)][int]$WaitSeconds = 45,
  [switch]$Run,
  [switch]$NoPrompt,
  [switch]$RemoveSigningCert,
  [switch]$AllowSchemaUpgrade,
  [switch]$Force,
  [string]$ProfileRoot,
  [ValidateSet('appdata', 'userprofile')][string]$DataLocation
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Apply = [bool]$Run
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Checks = New-Object System.Collections.Generic.List[object]
$script:Lines = New-Object System.Collections.Generic.List[string]
$script:Data = [ordered]@{}
$script:State = [ordered]@{
  CertAdded = $false; PackageAdded = $false; Thumbprint = $null; PackageFullName = $null
  PackageFamilyName = $null; TornDown = $false; PkgRoot = $null
  BackupVerified = $false; SchemaNote = $null
}

$ProcessName = 'Burrow'
$SidecarName = 'burrow-server'
# Where 'Burrow Data' and the backups live: the user profile (a test can point it elsewhere with -ProfileRoot).
$ProfileBase = $env:USERPROFILE
if ($ProfileRoot) { $ProfileBase = $ProfileRoot }
# A backup refuses a folder that cannot be a Burrow data folder: a .git folder, too many files or too many bytes (-Force lifts it).
$BackupMaxFiles = 5000
$BackupMaxBytes = 1GB
$MarkerName = '.burrow-data.json'
# The direct edition's folder. $DataFolder (set below, once the data location is known) is where the test package keeps
# its data: this same folder in appdata mode, %USERPROFILE%\Burrow Data in userprofile mode.
$DirectFolder = Join-Path $env:APPDATA 'Burrow'
$DataFolder = $DirectFolder
$DevFolder = Join-Path $env:APPDATA 'Burrow Dev'
$CertStore = 'Cert:\LocalMachine\TrustedPeople'
# Data files that must never appear under the package's LocalCache (logs are allowed there).
$DataPatterns = @('burrow.db*', 'secrets.key', 'license-*.json', '*.sqlite', '*.sqlite3')

function Say([string]$Text) {
  Write-Host $Text
  $script:Lines.Add($Text)
}

function Add-Check([string]$Step, [string]$Name, [string]$Status, [string]$Detail) {
  $script:Checks.Add([pscustomobject]@{ Step = $Step; Name = $Name; Status = $Status; Detail = $Detail })
  $tail = ''
  if ($Detail) { $tail = ' - ' + $Detail }
  Say ('  [{0}] {1}: {2}{3}' -f $Status, $Step, $Name, $tail)
}

function Plan([string]$Text) {
  if ($script:Apply) { Say ('> ' + $Text) } else { Say ('[dry-run] would: ' + $Text) }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FileHashShared([string]$Path) {
  # Opens with FileShare.ReadWrite so a database that the app still holds open can be hashed.
  $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $stream.Dispose() }
}

# True when $Bytes are the bytes of a marker Burrow wrote. The same rule as the app (server/dataFolderOwnership.js and
# src-tauri/src/data_guard.rs), pinned by server/__tests__/fixtures/markers.json: no leading byte order mark, strict UTF-8, a
# JSON object whose app, edition and dataLocation are exactly 'Burrow', 'store' and 'userprofile' (case-sensitive, keys
# included), a string createdAt and formatVersion written as the integer 1 (1.0 and "1" are refused). Unknown extra fields are
# ignored. Written for Windows PowerShell 5.1 (ConvertFrom-Json there keeps the last of a repeated key, like the app). One
# known difference, in the safe direction: 5.1 cannot parse an object that has two keys differing only in case (app and
# App), so such a marker is refused here although the app would accept it.
function Test-MarkerBytes([byte[]]$Bytes) {
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { return $false }
  try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($Bytes) } catch { return $false }
  # ConvertFrom-Json unwraps a one-element array into its element, so a JSON array must be refused before parsing.
  if ($text -notmatch '^[ \t\r\n]*\{') { return $false }
  try { $m = $text | ConvertFrom-Json } catch { return $false }
  if ($null -eq $m -or $m -isnot [System.Management.Automation.PSCustomObject]) { return $false }
  # Property names are case-insensitive in PowerShell; the marker's keys are not, so look them up in a case-sensitive map.
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($prop in $m.PSObject.Properties) { $d[$prop.Name] = $prop.Value }
  foreach ($key in @('app', 'edition', 'dataLocation', 'createdAt', 'formatVersion')) { if (-not $d.ContainsKey($key)) { return $false } }
  if ($d['app'] -isnot [string] -or $d['edition'] -isnot [string] -or $d['dataLocation'] -isnot [string]) { return $false }
  if (-not ($d['app'] -ceq 'Burrow' -and $d['edition'] -ceq 'store' -and $d['dataLocation'] -ceq 'userprofile')) { return $false }
  if ($d['createdAt'] -isnot [string] -and $d['createdAt'] -isnot [datetime]) { return $false }
  $v = $d['formatVersion']
  return (($v -is [int] -or $v -is [long]) -and $v -eq 1)
}

# What the folder at $Path is, for the userprofile data folder: Burrow writes .burrow-data.json when it creates the folder and
# uses an existing folder only with a valid marker (or when it is empty). Reads only; never follows a link, junction or other
# reparse point (a dangling one is a link, not a missing folder). State: missing | empty | marked | refused (Reason says why;
# an unreadable folder or listing is refused as unreadable). A marker named in another case is the same file on NTFS and is read.
function Test-DataFolderOwnership([string]$Path) {
  $attrs = $null
  try { $attrs = [System.IO.File]::GetAttributes($Path) }
  catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return [pscustomobject]@{ State = 'missing'; Reason = '' } }
  catch { return [pscustomobject]@{ State = 'refused'; Reason = ('unreadable: ' + $_.Exception.Message) } }
  if ($attrs -band [System.IO.FileAttributes]::ReparsePoint) {
    $kind = 'unknown'
    try { $kind = [string](Get-Item -LiteralPath $Path -Force -ErrorAction Stop).LinkType } catch { $kind = 'unknown' }
    if ($kind -eq 'Junction' -or $kind -eq 'SymbolicLink') { return [pscustomobject]@{ State = 'refused'; Reason = 'it is a shortcut, symbolic link or junction' } }
    if ($kind -eq 'unknown') { return [pscustomobject]@{ State = 'refused'; Reason = 'it is a link, junction or other reparse point (possibly dangling)' } }
    return [pscustomobject]@{ State = 'refused'; Reason = 'it is a cloud or other special folder (reparse point)' }
  }
  if (-not ($attrs -band [System.IO.FileAttributes]::Directory)) { return [pscustomobject]@{ State = 'refused'; Reason = 'it is a file, not a folder' } }
  try { $entries = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) }
  catch { return [pscustomobject]@{ State = 'refused'; Reason = ('unreadable: ' + $_.Exception.Message) } }
  if ($entries.Count -eq 0) { return [pscustomobject]@{ State = 'empty'; Reason = '' } }
  $markerFile = $entries | Where-Object { $_.Name -ieq $MarkerName } | Select-Object -First 1
  if (-not $markerFile) { return [pscustomobject]@{ State = 'refused'; Reason = ('it already holds ' + $entries.Count + ' other item(s) and has no ' + $MarkerName) } }
  if (($markerFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $markerFile.PSIsContainer -or $markerFile.Length -gt 4096) {
    return [pscustomobject]@{ State = 'refused'; Reason = ('its ' + $MarkerName + ' is not a plain small file') }
  }
  try { $bytes = [System.IO.File]::ReadAllBytes($markerFile.FullName) }
  catch { return [pscustomobject]@{ State = 'refused'; Reason = ('unreadable: its ' + $MarkerName + ' could not be read') } }
  if (-not (Test-MarkerBytes $bytes)) { return [pscustomobject]@{ State = 'refused'; Reason = ('its ' + $MarkerName + ' is not a valid Burrow marker') } }
  return [pscustomobject]@{ State = 'marked'; Reason = '' }
}

# -Run changes this PC (certificate, package, backups), so it must act on the real profile: -ProfileRoot is for dry runs and
# tests only. Ok is false for -Run with a -ProfileRoot that is not %USERPROFILE%.
function Test-ProfileRootAllowed([bool]$Apply, [string]$Root, [string]$UserProfile) {
  if (-not $Apply -or -not $Root) { return [pscustomobject]@{ Ok = $true; Detail = '' } }
  $same = $false
  if ($UserProfile) {
    $a = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $b = [System.IO.Path]::GetFullPath($UserProfile).TrimEnd('\')
    $same = ($a -ieq $b)
  }
  if ($same) { return [pscustomobject]@{ Ok = $true; Detail = '' } }
  return [pscustomobject]@{ Ok = $false; Detail = ('-ProfileRoot ' + $Root + ' is not your user profile (' + $UserProfile + '). -ProfileRoot is for dry runs and tests only; -Run must act on the real profile. Run again without -ProfileRoot.') }
}

# Throws when $Source cannot be a Burrow data folder: it has a .git folder, more than $BackupMaxFiles files or more than
# $BackupMaxBytes bytes. -Force lifts it. Stops counting as soon as a limit is passed, so a huge folder is not walked.
function Assert-BackupSane([string]$Source, [string]$Label) {
  if ($Force) { return }
  if (Test-Path -LiteralPath (Join-Path $Source '.git')) {
    Add-Check 'b' ($Label + ' backup safety') 'FAIL' ($Source + ' contains a .git folder: it is a source repository, not Burrow data. It was not copied. (-Force overrides this check.)')
    throw 'Backup refused: the folder looks like a source repository. Nothing was copied or changed.'
  }
  $seen = @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File -ErrorAction SilentlyContinue | Select-Object -First ($BackupMaxFiles + 1))
  $bytes = 0L
  foreach ($f in $seen) { $bytes += $f.Length }
  if ($seen.Count -gt $BackupMaxFiles) {
    Add-Check 'b' ($Label + ' backup safety') 'FAIL' ($Source + ' holds more than ' + $BackupMaxFiles + ' files, far more than a Burrow data folder. It was not copied. (-Force overrides this check.)')
    throw 'Backup refused: the folder is much larger than Burrow data. Nothing was copied or changed.'
  }
  if ($bytes -gt $BackupMaxBytes) {
    Add-Check 'b' ($Label + ' backup safety') 'FAIL' ($Source + ' holds more than 1 GB, far more than a Burrow data folder. It was not copied. (-Force overrides this check.)')
    throw 'Backup refused: the folder is much larger than Burrow data. Nothing was copied or changed.'
  }
}

function Get-Tree([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  $prefix = (Get-Item -LiteralPath $Root).FullName.TrimEnd('\') + '\'
  return @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        Rel = $_.FullName.Substring($prefix.Length)
        Length = $_.Length
        LastWriteUtc = $_.LastWriteTimeUtc.ToString('o')
      }
    })
}

function Get-Snapshot([string]$Root) {
  $files = @(Get-Tree $Root)
  $db = Join-Path $Root 'burrow.db'
  $dbHash = $null
  if (Test-Path -LiteralPath $db) {
    try { $dbHash = Get-FileHashShared $db } catch { $dbHash = 'unreadable: ' + $_.Exception.Message }
  }
  $sum = 0L
  foreach ($f in $files) { $sum += $f.Length }
  return [pscustomobject]@{
    Path = $Root
    Exists = (Test-Path -LiteralPath $Root)
    FileCount = $files.Count
    TotalBytes = $sum
    DbSha256 = $dbHash
    Files = $files
  }
}

function Compare-Snapshots($Before, $After) {
  $old = @{}
  foreach ($f in $Before.Files) { $old[$f.Rel] = $f }
  $new = @(); $changed = @()
  foreach ($f in $After.Files) {
    if (-not $old.ContainsKey($f.Rel)) { $new += $f.Rel }
    elseif ($old[$f.Rel].Length -ne $f.Length -or $old[$f.Rel].LastWriteUtc -ne $f.LastWriteUtc) { $changed += $f.Rel }
  }
  $afterSet = @{}
  foreach ($f in $After.Files) { $afterSet[$f.Rel] = $true }
  $gone = @($Before.Files | Where-Object { -not $afterSet.ContainsKey($_.Rel) } | ForEach-Object { $_.Rel })
  return [pscustomobject]@{ New = $new; Changed = $changed; Missing = $gone }
}

function Read-ZipEntryText($Zip, [string]$Name) {
  $entry = $Zip.GetEntry($Name)
  if (-not $entry) { return $null }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

# Reads the identity from the bundle itself: bundle manifest Name/Publisher, and the AppId from the manifest of the
# package that matches this PC's architecture (the AppId is what shell:AppsFolder needs).
function Read-BundleIdentity([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $bm = Read-ZipEntryText $zip 'AppxMetadata/AppxBundleManifest.xml'
    if (-not $bm) { throw 'AppxBundleManifest.xml not found in the bundle' }
    $bx = [xml]$bm
    $name = $bx.Bundle.Identity.Name
    $publisher = $bx.Bundle.Identity.Publisher
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
    $apps = @($bx.Bundle.Packages.Package | Where-Object { $_.Type -eq 'application' })
    $pkg = $apps | Where-Object { $_.Architecture -eq $arch } | Select-Object -First 1
    if (-not $pkg) { $pkg = $apps | Select-Object -First 1 }
    $appId = $null
    $appVersion = $null
    $caps = @()
    $hasUnvirtualized = $false
    $hasWriteVirtualization = $false
    $inner = $zip.GetEntry($pkg.FileName)
    if ($inner) {
      $ms = New-Object System.IO.MemoryStream
      $s = $inner.Open(); $s.CopyTo($ms); $s.Dispose(); $ms.Position = 0
      $innerZip = New-Object System.IO.Compression.ZipArchive($ms)
      try {
        $mx = [xml](Read-ZipEntryText $innerZip 'AppxManifest.xml')
        $appId = @($mx.Package.Applications.Application)[0].Id
        $caps = @($mx.Package.Capabilities.ChildNodes | Where-Object { $_.LocalName -eq 'Capability' } | ForEach-Object { $_.GetAttribute('Name') })
        $hasUnvirtualized = ($caps -contains 'unvirtualizedResources')
        $hasWriteVirtualization = (@($mx.Package.Properties.ChildNodes | Where-Object { $_.LocalName -eq 'FileSystemWriteVirtualization' }).Count -gt 0)
        $pkgVersion = [string]$mx.Package.Identity.Version
        if ($pkgVersion -match '^(\d+\.\d+\.\d+)\.\d+$') { $appVersion = $Matches[1] }
      } finally { $innerZip.Dispose() }
    }
    # The manifest decides the data location: no unvirtualizedResources means MSIX virtualizes AppData, so the app keeps its
    # data in %USERPROFILE%\Burrow Data (data location userprofile).
    $location = 'userprofile'
    if ($hasUnvirtualized) { $location = 'appdata' }
    return [pscustomobject]@{
      Name = $name; Publisher = $publisher; AppId = $appId; AppVersion = $appVersion; InnerPackage = $pkg.FileName
      Capabilities = $caps; DataLocation = $location; ManifestConsistent = ($hasUnvirtualized -eq $hasWriteVirtualization)
    }
  } finally { $zip.Dispose() }
}

# Version of the installed direct (NSIS) Burrow from the Uninstall keys; $null when it cannot be read.
function Get-DirectBurrowVersion {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    foreach ($item in @(Get-ItemProperty -Path $r -ErrorAction SilentlyContinue)) {
      $dn = $item.PSObject.Properties['DisplayName']
      $dv = $item.PSObject.Properties['DisplayVersion']
      if ($dn -and $dn.Value -eq 'Burrow' -and $dv -and $dv.Value) {
        $text = ([string]$dv.Value).Trim()
        if ($text -match '^(\d+\.\d+\.\d+)') { return $Matches[1] }
      }
    }
  }
  return $null
}

function Get-InstalledPackage([string]$Name) {
  $p = @(Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue)
  if ($p.Count -eq 0 -and (Test-Admin)) { $p = @(Get-AppxPackage -Name $Name -AllUsers -ErrorAction SilentlyContinue) }
  return $p | Select-Object -First 1
}

# Copies $Source to $Dest and verifies it (file count, total size, burrow.db SHA256). Any failure throws, so the run stops
# before the certificate and the install. Returns the BEFORE snapshot of $Source.
function Invoke-VerifiedBackup([string]$Source, [string]$Dest, [string]$Label) {
  if (Test-Path -LiteralPath $Source) { Assert-BackupSane $Source $Label }
  $snap = Get-Snapshot $Source
  if (-not $snap.Exists) {
    Add-Check 'b' ($Label + ' backup') 'INFO' ($Source + ' does not exist yet (fresh machine); nothing to back up')
    return $snap
  }
  try {
    Copy-Item -LiteralPath $Source -Destination $Dest -Recurse -Force
  } catch {
    Add-Check 'b' ($Label + ' backup copy') 'FAIL' $_.Exception.Message
    throw 'Backup copy failed; stopping before anything is installed. The real data folder was not changed.'
  }
  $copy = Get-Snapshot $Dest
  if ($copy.FileCount -ne $snap.FileCount -or $copy.TotalBytes -ne $snap.TotalBytes) {
    Add-Check 'b' ($Label + ' backup verified') 'FAIL' ('source {0} files/{1} bytes, copy {2} files/{3} bytes' -f $snap.FileCount, $snap.TotalBytes, $copy.FileCount, $copy.TotalBytes)
    throw 'Backup could not be verified; stopping before anything is installed.'
  }
  if ($snap.DbSha256 -and ($snap.DbSha256 -like 'unreadable:*')) {
    Add-Check 'b' ($Label + ' backup verified') 'FAIL' ('the original burrow.db could not be hashed (' + $snap.DbSha256 + ')')
    throw 'Backup could not be verified; stopping before anything is installed.'
  }
  if ($snap.DbSha256 -and $copy.DbSha256 -ne $snap.DbSha256) {
    Add-Check 'b' ($Label + ' backup verified') 'FAIL' ('burrow.db SHA256 differs: source ' + $snap.DbSha256 + ', copy ' + $copy.DbSha256)
    throw 'Backup could not be verified; stopping before anything is installed.'
  }
  $hashText = 'no burrow.db to hash'
  if ($snap.DbSha256) { $hashText = 'burrow.db sha256 matches' }
  Add-Check 'b' ($Label + ' backup verified') 'PASS' ('{0} files, {1} bytes, {2}, in {3}' -f $copy.FileCount, $copy.TotalBytes, $hashText, $Dest)
  return $snap
}

# True when the folder is exactly as the BEFORE snapshot (same files, sizes, times and burrow.db hash).
function Test-FolderUnchanged($Before, $Root) {
  $now = Get-Snapshot $Root
  $d = Compare-Snapshots $Before $now
  $same = ($d.New.Count -eq 0 -and $d.Changed.Count -eq 0 -and $d.Missing.Count -eq 0 -and $now.DbSha256 -eq $Before.DbSha256 -and $now.Exists -eq $Before.Exists)
  $parts = @()
  if ($d.New.Count -gt 0) { $parts += ('new: ' + ($d.New -join ', ')) }
  if ($d.Changed.Count -gt 0) { $parts += ('changed: ' + ($d.Changed -join ', ')) }
  if ($d.Missing.Count -gt 0) { $parts += ('missing: ' + ($d.Missing -join ', ')) }
  if ($now.DbSha256 -ne $Before.DbSha256) { $parts += 'burrow.db sha256 differs' }
  return [pscustomobject]@{ Same = $same; Detail = ($parts -join '; '); Snapshot = $now }
}

function Close-Burrow([string]$Step) {
  $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  foreach ($p in $procs) { [void]$p.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and @(Get-Process -Name $ProcessName, $SidecarName -ErrorAction SilentlyContinue).Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-Process -Name $ProcessName, $SidecarName -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    $names = ($left | ForEach-Object { $_.ProcessName }) -join ', '
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Add-Check $Step 'closed gracefully' 'INFO' ('NOT graceful: Stop-Process was needed for ' + $names + ' after 30 s')
    return
  }
  Add-Check $Step 'closed gracefully' 'PASS' 'Burrow and the sidecar exited after CloseMainWindow'
}

function Wait-ProcessAppear([string]$Name, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

# Step g: close the app, remove the package, then prove the real data survived. Safe to call twice.
function Invoke-Teardown {
  if ($script:State.TornDown) { return }
  Close-Burrow 'g'
  $pkg = Get-AppxPackage -Name $script:ExpectedName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) { Remove-AppxPackage -Package $pkg.PackageFullName }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Get-AppxPackage -Name $script:ExpectedName -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1 }
  if (Get-AppxPackage -Name $script:ExpectedName -ErrorAction SilentlyContinue) {
    Add-Check 'g' 'package removed' 'FAIL' 'still installed after Remove-AppxPackage'
  } else {
    Add-Check 'g' 'package removed' 'PASS' ''
    $script:State.PackageAdded = $false
  }
  if ($script:State.PkgRoot) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $script:State.PkgRoot)) { Start-Sleep -Seconds 1 }
    if (Test-Path -LiteralPath $script:State.PkgRoot) { Add-Check 'g' 'Packages folder removed' 'FAIL' ($script:State.PkgRoot + ' still exists') }
    else { Add-Check 'g' 'Packages folder removed' 'PASS' $script:State.PkgRoot }
  }
  $final = Get-Snapshot $DataFolder
  $script:Data['Final'] = $final
  if ($final.Exists -and $final.FileCount -gt 0) {
    Add-Check 'g' 'real data folder still exists' 'PASS' ('{0} files, {1} bytes' -f $final.FileCount, $final.TotalBytes)
  } elseif ($script:Data.Contains('Before') -and -not $script:Data['Before'].Exists) {
    Add-Check 'g' 'real data folder' 'INFO' 'there was none before; none now'
  } else {
    Add-Check 'g' 'real data folder still exists' 'FAIL' ($DataFolder + ' is missing or empty after uninstall')
  }
  if ($final.DbSha256) {
    $prev = $null
    if ($script:Data.Contains('After')) { $prev = $script:Data['After'].DbSha256 }
    $note = 'unchanged since AFTER'
    if ($prev -and $prev -ne $final.DbSha256) { $note = 'changed since AFTER (the app checkpoints on exit; expected)' }
    Add-Check 'g' 'burrow.db intact' 'PASS' ('sha256 ' + $final.DbSha256 + '; ' + $note)
  } elseif ($script:Data.Contains('Before') -and $script:Data['Before'].DbSha256) {
    Add-Check 'g' 'burrow.db intact' 'FAIL' 'burrow.db is gone'
  }
  if ($script:Data.Contains('Before')) {
    $d = Compare-Snapshots $script:Data['Before'] $final
    $missingBackups = @($d.Missing | Where-Object { $_ -like 'backups\*' })
    $missingAll = @($d.Missing | Where-Object { $_ -notlike 'backups\*' })
    # burrow.db-wal and burrow.db-shm are SQLite's transient files: SQLite checkpoints and deletes them on a clean close, so
    # they are legitimately gone after the app quit. Only burrow.db itself and every other file must still be there.
    $missingTransient = @($missingAll | Where-Object { $_ -eq 'burrow.db-wal' -or $_ -eq 'burrow.db-shm' })
    $missingOther = @($missingAll | Where-Object { $_ -ne 'burrow.db-wal' -and $_ -ne 'burrow.db-shm' })
    if ($missingOther.Count -eq 0) { Add-Check 'g' 'every file from BEFORE still present' 'PASS' 'outside backups\ and the transient SQLite files' }
    else { Add-Check 'g' 'every file from BEFORE still present' 'FAIL' ($missingOther -join ', ') }
    if ($missingTransient.Count -gt 0) {
      Add-Check 'g' 'transient SQLite files gone after a clean close' 'INFO' (($missingTransient -join ', ') + ' (SQLite checkpoints and deletes them when the database closes cleanly; not a data loss)')
    }
    if ($missingBackups.Count -gt 0) {
      $keptIn = 'the backup folder'
      if ($script:Data.Contains('BackupFolder')) { $keptIn = $script:Data['BackupFolder'] }
      Add-Check 'g' 'files missing under backups\' 'INFO' ('removed by backup retention; a copy is kept in ' + $keptIn + ' (' + ($missingBackups -join ', ') + ')')
    }
  }
  $bk = @(Get-Tree (Join-Path $DataFolder 'backups'))
  Add-Check 'g' 'backups present' 'INFO' ('{0} file(s) in backups\' -f $bk.Count)
  if ($script:Location -eq 'userprofile' -and $script:Data.Contains('BeforeDirect')) {
    $u = Test-FolderUnchanged $script:Data['BeforeDirect'] $DirectFolder
    if ($u.Same) { Add-Check 'g' 'direct data folder unchanged after uninstall' 'PASS' ('{0} files, {1} bytes' -f $u.Snapshot.FileCount, $u.Snapshot.TotalBytes) }
    else { Add-Check 'g' 'direct data folder unchanged after uninstall' 'FAIL' ($DirectFolder + ': ' + $u.Detail) }
  }
  $dev = Get-Snapshot $DevFolder
  if ($script:Data.Contains('BeforeDev')) {
    if ($dev.FileCount -eq $script:Data['BeforeDev'].FileCount -and $dev.TotalBytes -eq $script:Data['BeforeDev'].TotalBytes) {
      Add-Check 'g' 'Burrow Dev folder untouched' 'PASS' ('{0} files, {1} bytes' -f $dev.FileCount, $dev.TotalBytes)
    } else { Add-Check 'g' 'Burrow Dev folder untouched' 'FAIL' 'file count or size differs from BEFORE' }
  }
  $script:State.TornDown = $true
}

# Steps h and the finally block: remove only what this script added. Safe to call twice.
function Invoke-CertCleanup {
  $thumb = $script:State.Thumbprint
  if ($script:State.CertAdded -and $thumb) {
    $path = Join-Path $CertStore $thumb
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    if (Test-Path -LiteralPath $path) { Add-Check 'h' 'certificate removed from LocalMachine\TrustedPeople' 'FAIL' $thumb }
    else { Add-Check 'h' 'certificate removed from LocalMachine\TrustedPeople' 'PASS' $thumb; $script:State.CertAdded = $false }
  }
  if ($RemoveSigningCert -and $thumb) {
    $path = Join-Path 'Cert:\CurrentUser\My' $thumb
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
      Add-Check 'h' 'signing certificate removed from CurrentUser\My' 'PASS' $thumb
    } else { Add-Check 'h' 'signing certificate in CurrentUser\My' 'INFO' 'not present' }
  }
}

function Write-Report([string]$TextPath, [bool]$Passed) {
  $failed = @($script:Checks | Where-Object { $_.Status -eq 'FAIL' })
  $script:Lines.Add('')
  if ($Passed) { $script:Lines.Add('RESULT: PASS') } else { $script:Lines.Add('RESULT: FAIL (' + $failed.Count + ' failed check(s))') }
  $script:Lines.Add('')
  $installed = ($script:State.PackageAdded -or $script:State.TornDown)
  $beforeSnap = $null
  if ($script:Data.Contains('Before')) { $beforeSnap = $script:Data['Before'] }
  $hadData = ($beforeSnap -and $beforeSnap.Exists)
  if ($script:State.SchemaNote) {
    $script:Lines.Add($script:State.SchemaNote)
    $script:Lines.Add('')
  }
  if (-not $installed) {
    $script:Lines.Add('Nothing was installed by this run, so no restore is needed.')
    if ($script:Data.Contains('BackupFolder') -and -not $script:State.BackupVerified -and $hadData) {
      $script:Lines.Add('The backup in ' + $script:Data['BackupFolder'] + ' was NOT verified and may be incomplete; you can delete that folder.')
    }
    $script:Lines.Add('The real data folder (' + $DataFolder + ') was only read, never changed, by this script.')
  } elseif ($hadData -and $script:State.BackupVerified) {
    $script:Lines.Add('To go back to your data from before the test (close Burrow first). The backup in')
    $script:Lines.Add($script:Data['BackupFolder'] + '\Burrow was verified (file count, size and burrow.db SHA256) when it was made.')
    $script:Lines.Add('  1. Rename-Item -LiteralPath "' + $DataFolder + '" -NewName "Burrow.after-sideload-' + $script:Stamp + '"')
    $script:Lines.Add('  2. robocopy "' + $script:Data['BackupFolder'] + '\Burrow" "' + $DataFolder + '" /E')
    $script:Lines.Add('  (the renamed folder keeps whatever the test changed; delete it only when you no longer need it. Do not use /MIR.)')
  } elseif ($hadData) {
    $script:Lines.Add('The package was installed but there is NO verified backup, so do not restore from any BurrowBackup folder.')
    $script:Lines.Add('Your data folder (' + $DataFolder + ') may have been changed by the test build.')
  } else {
    $script:Lines.Add('No Burrow data folder existed before this run. To remove what the test created (close Burrow first):')
    $script:Lines.Add('  Rename-Item -LiteralPath "' + $DataFolder + '" -NewName "Burrow.after-sideload-' + $script:Stamp + '"')
  }
  # userprofile mode: the direct Burrow's folder must come out unchanged. If that check failed, give the restore steps for it too
  # (the verified copy is BurrowDirect next to Burrow in the backup folder).
  $directFailed = @($script:Checks | Where-Object { $_.Status -eq 'FAIL' -and $_.Name -like '*direct data*unchanged*' })
  if ($script:Location -eq 'userprofile' -and $directFailed.Count -gt 0 -and $script:Data.Contains('BackupFolder') -and $script:Data.Contains('BeforeDirect')) {
    $script:Lines.Add('')
    $script:Lines.Add('The direct Burrow data (' + $DirectFolder + ') did NOT come out unchanged. Its verified copy is in')
    $script:Lines.Add($script:Data['BackupFolder'] + '\BurrowDirect. To go back to it (close the direct Burrow first):')
    $script:Lines.Add('  1. Rename-Item -LiteralPath "' + $DirectFolder + '" -NewName "Burrow.after-sideload-direct-' + $script:Stamp + '"')
    $script:Lines.Add('  2. robocopy "' + $script:Data['BackupFolder'] + '\BurrowDirect" "' + $DirectFolder + '" /E')
    $script:Lines.Add('  (the renamed folder keeps whatever changed; delete it only when you no longer need it. Do not use /MIR.)')
  }
  if ($script:State.PackageAdded -or $script:State.CertAdded) {
    $script:Lines.Add('The package or certificate may still be there: Get-AppxPackage ' + $script:ExpectedName + ' | Remove-AppxPackage')
    $script:Lines.Add('  and remove the certificate with thumbprint ' + $script:State.Thumbprint + ' from ' + $CertStore + '.')
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($TextPath, ($script:Lines -join "`r`n") + "`r`n", $utf8)
  $result = 'FAIL'
  if ($Passed) { $result = 'PASS' }
  $json = [ordered]@{ result = $result; generated = (Get-Date).ToString('o'); checks = $script:Checks; data = $script:Data }
  $jsonPath = [System.IO.Path]::ChangeExtension($TextPath, '.json')
  [System.IO.File]::WriteAllText($jsonPath, ($json | ConvertTo-Json -Depth 8), $utf8)
  Write-Host ('Report: ' + $TextPath)
  Write-Host ('Report (json): ' + $jsonPath)
}

# ---------------------------------------------------------------- inputs
if (-not $Bundle) {
  $storeRoot = Join-Path $env:LOCALAPPDATA 'burrow-release\store'
  # appdata packages live in <version>-localtest, userprofile ones in <version>-localtest-userprofile (their names carry
  # "userprofile" so the two cannot be mixed up). Without -DataLocation the newest of either is taken.
  $patterns = @('*-localtest\Burrow_*.msixbundle', '*-localtest-userprofile\Burrow_*_userprofile.msixbundle')
  $buildHint = 'npm run release:store -- --local-test --sign-local-test'
  if ($DataLocation -eq 'appdata') { $patterns = @($patterns[0]) }
  if ($DataLocation -eq 'userprofile') { $patterns = @($patterns[1]); $buildHint = $buildHint + ' --data-location userprofile' }
  $found = @()
  foreach ($pat in $patterns) { $found += @(Get-ChildItem -Path (Join-Path $storeRoot $pat) -ErrorAction SilentlyContinue) }
  $found = @($found | Sort-Object LastWriteTime -Descending)
  if ($found.Count -eq 0) {
    Write-Host ('No local-test bundle found under ' + $storeRoot + '. Build one: ' + $buildHint)
    exit 1
  }
  $Bundle = $found[0].FullName
}
if (-not $Cer) { $Cer = Join-Path (Split-Path -Parent $Bundle) 'BurrowLocalTest.cer' }
if (-not $ReportPath) { $ReportPath = Join-Path (Split-Path -Parent $Bundle) ('sideload-report-' + $script:Stamp + '.txt') }

$config = $null
$configPath = Join-Path $PSScriptRoot '..\..\config\msstore.json'
if (Test-Path -LiteralPath $configPath) { $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
$script:ExpectedName = 'NeuralFoundry.BurrowPrivateLifeOrganizer'
$ExpectedPublisher = $null
if ($config) { $script:ExpectedName = $config.identityName; $ExpectedPublisher = $config.publisher }

# The data location: the parameter, else what the bundle's manifest says, else appdata. A parameter that disagrees with the
# bundle is a preflight failure (checked in step a); the data folder below follows the parameter in that case.
$bundleLocation = $null
$bundleManifestOk = $true
if (Test-Path -LiteralPath $Bundle) {
  try {
    $peek = Read-BundleIdentity $Bundle
    $bundleLocation = $peek.DataLocation
    $bundleManifestOk = $peek.ManifestConsistent
  } catch { $bundleLocation = $null }
}
$script:Location = 'appdata'
$locationSource = 'default (no readable bundle)'
if ($DataLocation) { $script:Location = $DataLocation; $locationSource = '-DataLocation' }
elseif ($bundleLocation) { $script:Location = $bundleLocation; $locationSource = 'read from the bundle manifest' }
if ($script:Location -eq 'userprofile') { $DataFolder = Join-Path $ProfileBase 'Burrow Data' }
$script:Data['DataLocation'] = $script:Location

if ($script:Apply) { $mode = 'RUN: changes will be made' } else { $mode = 'DRY RUN: nothing is changed' }
if ($NoPrompt) { $promptText = 'off (-NoPrompt)' } else { $promptText = 'on when interactive' }
Say ('Burrow MSIX sideload test  (' + $mode + ')')
Say ('Bundle:      ' + $Bundle)
Say ('Certificate: ' + $Cer)
Say ('Report:      ' + $ReportPath + ' (+ .json)')
Say ('Data location: ' + $script:Location + ' (' + $locationSource + ')')
Say ('Data folder: ' + $DataFolder + '   (Burrow Dev, noted only: ' + $DevFolder + ')')
if ($script:Location -eq 'userprofile') { Say ('Direct data:  ' + $DirectFolder + '   (must stay unchanged)') }
Say ('Wait:        ' + $WaitSeconds + ' s after launch; prompt ' + $promptText)
Say ''

$identity = $null
$cert = $null
$before = $null
$after = $null
$preflightOk = $true

try {
  # ------------------------------------------------------------ a. preflight
  Say 'a. Preflight'
  $admin = Test-Admin
  if ($script:Apply) {
    if ($admin) { Add-Check 'a' 'running elevated' 'PASS' '' }
    else {
      Add-Check 'a' 'running elevated' 'FAIL' 'Run this in an elevated PowerShell. Admin is needed because the test certificate must go into the machine certificate store (Cert:\LocalMachine\TrustedPeople); without it Add-AppxPackage fails with 0x800B0109.'
      $preflightOk = $false
    }
  } else {
    Say ('  (dry run) elevated now: ' + $admin + '. -Run needs an elevated PowerShell because the certificate goes into ' + $CertStore)
  }

  $rootCheck = Test-ProfileRootAllowed $script:Apply $ProfileRoot $env:USERPROFILE
  if (-not $rootCheck.Ok) {
    Add-Check 'a' '-ProfileRoot is the real user profile for -Run' 'FAIL' $rootCheck.Detail
    $preflightOk = $false
  }

  $running = @(Get-Process -Name $ProcessName, $SidecarName -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $list = ($running | ForEach-Object { $_.ProcessName + ' (pid ' + $_.Id + ')' }) -join ', '
    Add-Check 'a' 'Burrow is not running' 'FAIL' ('running: ' + $list + '. Quit Burrow (direct or Store edition) first; the test needs the data folder to itself.')
    $preflightOk = $false
  } else { Add-Check 'a' 'Burrow is not running' 'PASS' '' }

  $existing = Get-InstalledPackage $script:ExpectedName
  if ($existing) {
    Add-Check 'a' 'package not already installed' 'FAIL' ($existing.PackageFullName + ' is installed. Remove it first: Get-AppxPackage ' + $script:ExpectedName + ' | Remove-AppxPackage')
    $preflightOk = $false
  } else { Add-Check 'a' 'package not already installed' 'PASS' $script:ExpectedName }

  if (-not (Test-Path -LiteralPath $Bundle)) {
    Add-Check 'a' 'bundle exists' 'FAIL' $Bundle; $preflightOk = $false
  } elseif (-not (Test-Path -LiteralPath $Cer)) {
    Add-Check 'a' 'certificate exists' 'FAIL' $Cer; $preflightOk = $false
  } else {
    Add-Check 'a' 'bundle and certificate exist' 'PASS' ''
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Cer)
    $script:State.Thumbprint = $cert.Thumbprint
    $script:Data['CertThumbprint'] = $cert.Thumbprint
    $script:Data['CertSubject'] = $cert.Subject
    if ($ExpectedPublisher -and $cert.Subject -ne $ExpectedPublisher) {
      Add-Check 'a' 'certificate subject equals the publisher' 'FAIL' ('cert ' + $cert.Subject + ' vs config ' + $ExpectedPublisher); $preflightOk = $false
    } else { Add-Check 'a' 'certificate subject equals the publisher' 'PASS' $cert.Subject }

    try {
      $sig = Get-AuthenticodeSignature -LiteralPath $Bundle
      $signer = $sig.SignerCertificate
      if (-not $signer) {
        Add-Check 'a' 'bundle is signed' 'FAIL' ('status ' + $sig.Status); $preflightOk = $false
      } else {
        if ($signer.Subject -eq $cert.Subject) { Add-Check 'a' 'bundle signature subject equals the certificate subject' 'PASS' $signer.Subject }
        else { Add-Check 'a' 'bundle signature subject equals the certificate subject' 'FAIL' ('signed by ' + $signer.Subject); $preflightOk = $false }
        if ($signer.Thumbprint -eq $cert.Thumbprint) { Add-Check 'a' 'bundle signer is this certificate (thumbprint)' 'PASS' $cert.Thumbprint }
        else { Add-Check 'a' 'bundle signer is this certificate (thumbprint)' 'FAIL' ('signer ' + $signer.Thumbprint + ' vs cer ' + $cert.Thumbprint); $preflightOk = $false }
        Say ('  (signature status before trusting the certificate: ' + $sig.Status + '; "not trusted" is expected here)')
      }
    } catch { Add-Check 'a' 'bundle signature readable' 'FAIL' $_.Exception.Message; $preflightOk = $false }

    try {
      $identity = Read-BundleIdentity $Bundle
      $script:Data['BundleIdentity'] = $identity
      if ($identity.Name -eq $script:ExpectedName) { Add-Check 'a' 'package identity name' 'PASS' $identity.Name }
      else { Add-Check 'a' 'package identity name' 'FAIL' ('bundle ' + $identity.Name + ' vs expected ' + $script:ExpectedName); $preflightOk = $false }
      if ($ExpectedPublisher -and $identity.Publisher -ne $ExpectedPublisher) {
        Add-Check 'a' 'package publisher' 'FAIL' ('bundle ' + $identity.Publisher + ' vs ' + $ExpectedPublisher); $preflightOk = $false
      } else { Add-Check 'a' 'package publisher' 'PASS' $identity.Publisher }
      $manifestSays = $identity.DataLocation
      if ($DataLocation -and $DataLocation -ne $manifestSays) {
        Add-Check 'a' 'data location matches the bundle' 'FAIL' ('-DataLocation ' + $DataLocation + ' but the bundle manifest says ' + $manifestSays + ' (' + $(if ($manifestSays -eq 'appdata') { 'it has' } else { 'it has no' }) + ' rescap:unvirtualizedResources). Use the matching package, or leave -DataLocation out.')
        $preflightOk = $false
      } elseif ($DataLocation) { Add-Check 'a' 'data location matches the bundle' 'PASS' ($DataLocation + ' (manifest ' + $(if ($manifestSays -eq 'appdata') { 'has' } else { 'has no' }) + ' unvirtualizedResources)') }
      else { Add-Check 'a' 'data location' 'INFO' ($manifestSays + ' (read from the bundle manifest: ' + $(if ($manifestSays -eq 'appdata') { 'has' } else { 'has no' }) + ' rescap:unvirtualizedResources)') }
      if (-not $identity.ManifestConsistent) {
        Add-Check 'a' 'manifest is consistent' 'FAIL' 'desktop6:FileSystemWriteVirtualization and rescap:unvirtualizedResources must be both present or both absent'
        $preflightOk = $false
      }
      if ($identity.AppId) { Add-Check 'a' 'application id from the manifest' 'PASS' $identity.AppId }
      else { Add-Check 'a' 'application id from the manifest' 'FAIL' 'not found'; $preflightOk = $false }
    } catch { Add-Check 'a' 'bundle identity readable' 'FAIL' $_.Exception.Message; $preflightOk = $false }
  }

  # A newer bundle may migrate burrow.db forward; the older direct app then refuses the file (db_too_new). That only
  # happens when the test app opens the real %APPDATA%\Burrow\burrow.db (appdata mode). The userprofile build never opens
  # it: an import copies it and migrates only the copy, and step f/g verify %APPDATA%\Burrow stays unchanged.
  if ($identity -and $script:Location -eq 'userprofile') {
    Add-Check 'a' 'schema upgrade risk' 'PASS' ('not applicable in userprofile mode: the test app does not open ' + $DirectFolder + '\burrow.db')
  } elseif ($identity) {
    $directVersion = $null
    try { $directVersion = Get-DirectBurrowVersion } catch { $directVersion = $null }
    $bundleVersion = $identity.AppVersion
    $script:Data['DirectVersion'] = $directVersion
    $script:Data['BundleAppVersion'] = $bundleVersion
    $dirText = 'unknown'
    if ($directVersion) { $dirText = $directVersion }
    $bunText = 'unknown'
    if ($bundleVersion) { $bunText = $bundleVersion }
    $newer = $true
    if ($directVersion -and $bundleVersion) { $newer = ([version]$bundleVersion -gt [version]$directVersion) }
    $hasData = Test-Path -LiteralPath (Join-Path $DataFolder 'burrow.db')
    if (-not $hasData) {
      Add-Check 'a' 'schema upgrade risk' 'PASS' ('no burrow.db in ' + $DataFolder + ' yet; direct ' + $dirText + ', bundle ' + $bunText)
    } elseif (-not $newer) {
      Add-Check 'a' 'schema upgrade risk' 'PASS' ('bundle ' + $bunText + ' is not newer than the installed direct Burrow ' + $dirText)
    } else {
      $script:State.SchemaNote = 'Schema upgrade: the Store test build (' + $bunText + ') may have migrated burrow.db forward from the installed direct Burrow (' + $dirText + '). The older direct app then refuses the file (db_too_new). Restoring the backup with the steps below is the way back.'
      if ($AllowSchemaUpgrade) {
        Add-Check 'a' 'schema upgrade risk' 'INFO' ('allowed by -AllowSchemaUpgrade; direct ' + $dirText + ', bundle ' + $bunText + '. ' + $script:State.SchemaNote)
      } else {
        Add-Check 'a' 'schema upgrade risk' 'FAIL' ('The bundle (' + $bunText + ') is newer than the installed direct Burrow (' + $dirText + ') or that version is unknown. The Store test build may migrate burrow.db forward, so the older direct app would then refuse the file (db_too_new); restoring the backup (steps in the report) is the way back. Re-run with -AllowSchemaUpgrade to accept this.')
        $preflightOk = $false
      }
    }
  }

  # Userprofile mode: the data folder must be missing, empty or carry Burrow's own marker. Anything else is somebody else's folder
  # (a source repository, an old install, a file): the script will not back it up, and will not let the app near it.
  if ($script:Location -eq 'userprofile') {
    $own = Test-DataFolderOwnership $DataFolder
    switch ($own.State) {
      'missing' { Add-Check 'a' 'data folder is safe to use' 'PASS' ($DataFolder + ' does not exist; Burrow will create it with its ownership marker') }
      'empty' { Add-Check 'a' 'data folder is safe to use' 'PASS' ($DataFolder + ' is empty; Burrow will adopt it and write its ownership marker') }
      'marked' { Add-Check 'a' 'data folder is safe to use' 'PASS' ($DataFolder + ' carries a valid ' + $MarkerName) }
      default {
        Add-Check 'a' 'data folder is safe to use' 'FAIL' ($DataFolder + ' exists but is not a Burrow data folder (' + $own.Reason + '). It will not be backed up, started against or touched. Rename or move that folder, then run this again.')
        $preflightOk = $false
      }
    }
  }

  if (-not $preflightOk) { throw 'Preflight failed; nothing was changed.' }

  # ------------------------------------------------------------ b. backup + BEFORE
  Say ''
  Say 'b. Backup and BEFORE snapshot'
  $backupRoot = Join-Path $ProfileBase ('BurrowBackup-' + $script:Stamp)
  Plan ('copy ' + $DataFolder + ' to ' + $backupRoot + '\Burrow, verify file count, size and the burrow.db SHA256 (any failure stops before the certificate and install), record the BEFORE snapshot (sizes, times, SHA256 of burrow.db)')
  Plan ('refuse any backup of a folder with a .git folder, more than ' + $BackupMaxFiles + ' files or more than 1 GB (unless -Force); only a missing, empty or marked ' + $DataFolder + ' ever gets here')
  if ($script:Location -eq 'userprofile') {
    Plan ('copy the direct data ' + $DirectFolder + ' to ' + $backupRoot + '\BurrowDirect with the same checks, and record its BEFORE snapshot: it must come out unchanged')
  }
  Plan ('note (not copy, not touch) ' + $DevFolder)
  if ($script:Apply) {
    $before = Get-Snapshot $DataFolder
    $script:Data['Before'] = $before
    $script:Data['BeforeDev'] = Get-Snapshot $DevFolder
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $script:Data['BackupFolder'] = $backupRoot
    if ($before.Exists) {
      # Any failure inside throws, so the run stops before the certificate and the install. BackupVerified stays false
      # until every comparison passes.
      [void](Invoke-VerifiedBackup $DataFolder (Join-Path $backupRoot 'Burrow') 'data folder')
      $script:State.BackupVerified = $true
      $script:Data['BackupVerified'] = $true
    } else {
      Add-Check 'b' 'backup' 'INFO' ($DataFolder + ' does not exist yet (fresh machine); nothing to back up')
    }
    Add-Check 'b' 'BEFORE snapshot' 'INFO' ('{0} files, {1} bytes, burrow.db sha256 {2}' -f $before.FileCount, $before.TotalBytes, $before.DbSha256)
    if ($script:Location -eq 'userprofile') {
      $beforeDirect = Invoke-VerifiedBackup $DirectFolder (Join-Path $backupRoot 'BurrowDirect') 'direct data'
      $script:Data['BeforeDirect'] = $beforeDirect
      Add-Check 'b' 'BEFORE snapshot of the direct data' 'INFO' ('exists={0}, {1} files, {2} bytes, burrow.db sha256 {3}' -f $beforeDirect.Exists, $beforeDirect.FileCount, $beforeDirect.TotalBytes, $beforeDirect.DbSha256)
    }
    Add-Check 'b' 'Burrow Dev folder noted' 'INFO' ('exists={0}, {1} files' -f $script:Data['BeforeDev'].Exists, $script:Data['BeforeDev'].FileCount)
  }

  # ------------------------------------------------------------ c. certificate
  # LocalMachine\TrustedPeople, not CurrentUser: an earlier test on this PC showed that importing the certificate
  # into Cert:\CurrentUser\TrustedPeople still makes Add-AppxPackage fail with 0x800B0109. MSIX deployment validates
  # the sideload signature against the machine store, so the machine store is required, and that is why this
  # script needs admin. The thumbprint is remembered so only this certificate is removed afterwards.
  Say ''
  Say 'c. Trust the test certificate'
  Plan ('import the certificate into ' + $CertStore + ' (CurrentUser\TrustedPeople is not enough: it fails with 0x800B0109) and remember its thumbprint')
  if ($script:Apply) {
    if (Test-Path -LiteralPath (Join-Path $CertStore $cert.Thumbprint)) {
      Add-Check 'c' 'certificate trusted' 'INFO' 'already in LocalMachine\TrustedPeople; it will be left there'
    } else {
      Import-Certificate -FilePath $Cer -CertStoreLocation $CertStore | Out-Null
      $script:State.CertAdded = $true
      Add-Check 'c' 'certificate trusted in LocalMachine\TrustedPeople' 'PASS' ('thumbprint ' + $cert.Thumbprint)
    }
  }

  # ------------------------------------------------------------ d. install
  Say ''
  Say 'd. Install'
  Plan ('Add-AppxPackage -Path ' + $Bundle + ', then read PackageFamilyName (expected NeuralFoundry.BurrowPrivateLifeOrganizer_mgg9wnr6rtg28)')
  if ($script:Apply) {
    try { Add-AppxPackage -Path $Bundle }
    catch {
      Add-Check 'd' 'Add-AppxPackage' 'FAIL' $_.Exception.Message
      throw
    }
    $pkg = Get-AppxPackage -Name $script:ExpectedName | Select-Object -First 1
    if (-not $pkg) { Add-Check 'd' 'package installed' 'FAIL' 'Get-AppxPackage found nothing'; throw 'install did not register' }
    $script:State.PackageAdded = $true
    $script:State.PackageFullName = $pkg.PackageFullName
    $script:State.PackageFamilyName = $pkg.PackageFamilyName
    $script:State.PkgRoot = Join-Path $env:LOCALAPPDATA ('Packages\' + $pkg.PackageFamilyName)
    $script:Data['PackageFullName'] = $pkg.PackageFullName
    $script:Data['PackageFamilyName'] = $pkg.PackageFamilyName
    $script:Data['InstallLocation'] = $pkg.InstallLocation
    Add-Check 'd' 'package installed' 'PASS' $pkg.PackageFullName
    $expectedPfn = 'NeuralFoundry.BurrowPrivateLifeOrganizer_mgg9wnr6rtg28'
    if ($pkg.PackageFamilyName -eq $expectedPfn) { Add-Check 'd' 'PackageFamilyName' 'PASS' $pkg.PackageFamilyName }
    else { Add-Check 'd' 'PackageFamilyName' 'INFO' ('actual ' + $pkg.PackageFamilyName + ' (differs from the Store one ' + $expectedPfn + ' because the test certificate is self-signed; expected for a sideload)') }
  }

  # ------------------------------------------------------------ e. launch
  Say ''
  Say 'e. Launch'
  $appIdText = '<AppId>'
  if ($identity) { $appIdText = $identity.AppId }
  Plan ('explorer.exe shell:AppsFolder\<PackageFamilyName>!' + $appIdText + ', wait for Burrow.exe and burrow-server.exe, then wait ' + $WaitSeconds + ' s')
  Plan 'prompt (interactive only, unless -NoPrompt): make a change in Burrow and create a manual backup in Settings > Data & storage, then press Enter'
  if ($script:Location -eq 'userprofile') {
    Plan 'userprofile only: the first start offers "Import from your existing Burrow" in Settings > Data & storage when direct data exists; clicking it is optional and copies only (the script checks the direct data stays unchanged either way)'
  }
  if ($script:Apply) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $script:State.PackageFamilyName + '!' + $identity.AppId)
    $app = Wait-ProcessAppear $ProcessName 60
    if (-not $app) { Add-Check 'e' 'Burrow.exe started' 'FAIL' 'not running after 60 s'; throw 'Burrow did not start' }
    Add-Check 'e' 'Burrow.exe started' 'PASS' ('pid ' + $app.Id)
    $side = Wait-ProcessAppear $SidecarName 60
    if (-not $side) { Add-Check 'e' 'burrow-server.exe (sidecar) started' 'FAIL' 'not running after 60 s'; throw 'sidecar did not start' }
    Add-Check 'e' 'burrow-server.exe (sidecar) started' 'PASS' ('pid ' + $side.Id)
    Say ('  waiting ' + $WaitSeconds + ' s for the app to settle...')
    Start-Sleep -Seconds $WaitSeconds
    if (-not $NoPrompt -and [Environment]::UserInteractive) {
      [void](Read-Host 'Make a change in Burrow and create a manual backup in Settings > Data & storage, then press Enter')
      Add-Check 'e' 'manual change and backup prompt' 'INFO' 'confirmed by the user'
    } else { Add-Check 'e' 'manual change and backup prompt' 'SKIP' 'skipped (-NoPrompt or not interactive)' }
  }

  # ------------------------------------------------------------ f. AFTER
  Say ''
  Say 'f. AFTER snapshot'
  $pkgRoot = $script:State.PkgRoot
  if (-not $pkgRoot) { $pkgRoot = Join-Path $env:LOCALAPPDATA 'Packages\<PackageFamilyName>' }
  $virtRoaming = Join-Path $pkgRoot 'LocalCache\Roaming'
  $virtLocal = Join-Path $pkgRoot 'LocalCache\Local'
  Plan ('compare ' + $DataFolder + ' against the BEFORE snapshot; list files under ' + $virtRoaming + ' and ' + $virtLocal)
  Plan 'PASS = no Burrow data files (burrow.db*, secrets.key, license-*.json, backups) under LocalCache, and new or changed files in the real data folder'
  if ($script:Location -eq 'userprofile') {
    Plan ('userprofile: new files (burrow.db, secrets.key, logs\server.log) must land in ' + $DataFolder + ', and ' + $DirectFolder + ' must be exactly as before (files, sizes, times, burrow.db SHA256)')
  }
  Plan 'look for burrow-distribution=store and burrow-data-location=<mode> in the shell logs (no API login needed)'
  if ($script:Apply) {
    $after = Get-Snapshot $DataFolder
    $script:Data['After'] = $after
    $diff = Compare-Snapshots $before $after
    $script:Data['RealFolderDiff'] = $diff
    foreach ($n in @('burrow.db', 'burrow.db-wal', 'burrow.db-shm', 'secrets.key')) {
      $where = 'absent'
      if (Test-Path -LiteralPath (Join-Path $DataFolder $n)) { $where = 'present' }
      Add-Check 'f' ($n + ' in the real folder') 'INFO' $where
    }
    $lic = @(Get-ChildItem -LiteralPath $DataFolder -Filter 'license-*.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $licText = 'none'
    if ($lic.Count -gt 0) { $licText = $lic -join ', ' }
    Add-Check 'f' 'license files in the real folder' 'INFO' $licText
    $bk = @(Get-Tree (Join-Path $DataFolder 'backups'))
    Add-Check 'f' 'backups\* in the real folder' 'INFO' ('{0} file(s)' -f $bk.Count)
    $newText = 'none'; $chText = 'none'
    if ($diff.New.Count -gt 0) { $newText = $diff.New -join ', ' }
    if ($diff.Changed.Count -gt 0) { $chText = $diff.Changed -join ', ' }
    Add-Check 'f' 'new files in the real folder' 'INFO' $newText
    Add-Check 'f' 'changed files in the real folder' 'INFO' $chText
    if (($diff.New.Count + $diff.Changed.Count) -gt 0) { Add-Check 'f' ('real ' + $DataFolder + ' received new or changed files') 'PASS' ('{0} new, {1} changed' -f $diff.New.Count, $diff.Changed.Count) }
    else { Add-Check 'f' ('real ' + $DataFolder + ' received new or changed files') 'FAIL' 'nothing new or changed in the real folder' }
    if ($script:Location -eq 'userprofile') {
      $must = @('burrow.db', 'secrets.key')
      $missingNew = @($must | Where-Object { -not (Test-Path -LiteralPath (Join-Path $DataFolder $_)) })
      if ($missingNew.Count -eq 0) { Add-Check 'f' 'burrow.db and secrets.key landed in the user profile folder' 'PASS' $DataFolder }
      else { Add-Check 'f' 'burrow.db and secrets.key landed in the user profile folder' 'FAIL' ('missing: ' + ($missingNew -join ', ')) }
      $logFile = Join-Path $DataFolder 'logs\server.log'
      if (Test-Path -LiteralPath $logFile) { Add-Check 'f' 'server log written next to the data (logs\server.log)' 'PASS' $logFile }
      else { Add-Check 'f' 'server log written next to the data (logs\server.log)' 'FAIL' ($logFile + ' does not exist') }
      $u = Test-FolderUnchanged $script:Data['BeforeDirect'] $DirectFolder
      $script:Data['DirectAfter'] = $u.Snapshot
      if ($u.Same) { Add-Check 'f' ('direct data ' + $DirectFolder + ' unchanged') 'PASS' ('{0} files, {1} bytes, burrow.db sha256 {2}' -f $u.Snapshot.FileCount, $u.Snapshot.TotalBytes, $u.Snapshot.DbSha256) }
      else { Add-Check 'f' ('direct data ' + $DirectFolder + ' unchanged') 'FAIL' $u.Detail }
    }

    $virtFiles = @()
    foreach ($v in @($virtRoaming, $virtLocal)) {
      foreach ($f in (Get-Tree $v)) { $virtFiles += [pscustomobject]@{ Root = $v; Rel = $f.Rel; Length = $f.Length } }
    }
    $script:Data['LocalCacheFiles'] = $virtFiles
    $leaks = @()
    foreach ($vf in $virtFiles) {
      $leaf = Split-Path -Leaf $vf.Rel
      $isData = ($vf.Rel -like 'Burrow\backups\*') -or ($vf.Rel -like 'Burrow\*.db*')
      foreach ($pat in $DataPatterns) { if ($leaf -like $pat) { $isData = $true } }
      if ($isData) { $leaks += $vf }
    }
    Add-Check 'f' 'LocalCache contents (all files, logs allowed)' 'INFO' ('{0} file(s) under LocalCache\Roaming and LocalCache\Local' -f $virtFiles.Count)
    foreach ($vf in $virtFiles) { Say ('      ' + $vf.Root.Replace($pkgRoot, '<pkg>') + '\' + $vf.Rel + '  (' + $vf.Length + ' bytes)') }
    if ($leaks.Count -eq 0) { Add-Check 'f' 'no Burrow data files under LocalCache' 'PASS' '' }
    else { Add-Check 'f' 'no Burrow data files under LocalCache' 'FAIL' (($leaks | ForEach-Object { $_.Rel }) -join ', ') }

    # Logs: LocalAppData (appdata mode), or <data folder>\logs in userprofile mode; the virtualized copy is checked too.
    $logDirs = @((Join-Path $DataFolder 'logs'), (Join-Path $env:LOCALAPPDATA 'com.burrow.desktop\logs'), (Join-Path $virtLocal 'com.burrow.desktop\logs'))
    $locMarker = $null
    foreach ($d in $logDirs) {
      if ($locMarker) { break }
      if (Test-Path -LiteralPath $d) {
        $hit = Get-ChildItem -LiteralPath $d -Filter '*.log' -ErrorAction SilentlyContinue | Select-String -Pattern 'burrow-data-location=\w+' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { $locMarker = ($hit.Matches[0].Value + ' in ' + $hit.Path) }
      }
    }
    if ($locMarker) {
      $locStatus = 'FAIL'
      if ($locMarker -like ('burrow-data-location=' + $script:Location + '*')) { $locStatus = 'PASS' }
      Add-Check 'f' 'data location marker in the shell log' $locStatus $locMarker
    } else { Add-Check 'f' 'data location marker in the shell log' 'INFO' 'not found in the log folders checked' }
    $marker = $null
    foreach ($d in $logDirs) {
      if ($marker) { break }
      if (Test-Path -LiteralPath $d) {
        $hit = Get-ChildItem -LiteralPath $d -Filter '*.log' -ErrorAction SilentlyContinue | Select-String -Pattern 'burrow-distribution=\w+' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { $marker = ($hit.Matches[0].Value + ' in ' + $hit.Path) }
      }
    }
    if ($marker) {
      $markerStatus = 'FAIL'
      if ($marker -like 'burrow-distribution=store*') { $markerStatus = 'PASS' }
      Add-Check 'f' 'edition marker in the shell log' $markerStatus $marker
    } else { Add-Check 'f' 'edition marker in the shell log' 'INFO' 'not found in the log folders checked' }
  }

  # ------------------------------------------------------------ g. close + remove + data check
  Say ''
  Say 'g. Close, uninstall, confirm the data survived'
  Plan 'CloseMainWindow, wait up to 30 s for Burrow and the sidecar, Stop-Process only as a noted fallback'
  Plan 'Remove-AppxPackage, confirm the package and its LocalAppData\Packages folder are gone'
  Plan ('confirm ' + $DataFolder + ' still exists with burrow.db (SHA256 recorded) and every BEFORE file, and backups are present')
  if ($script:Apply) { Invoke-Teardown }

  # ------------------------------------------------------------ h. certificate removal
  Say ''
  Say 'h. Remove the certificate'
  $extra = ''
  if ($RemoveSigningCert) { $extra = '; also remove it from Cert:\CurrentUser\My' }
  Plan ('remove the certificate by thumbprint from ' + $CertStore + ' (only if this script added it)' + $extra)
  if ($script:Apply) { Invoke-CertCleanup }
} catch {
  Say ('ERROR: ' + $_.Exception.Message)
  if (@($script:Checks | Where-Object { $_.Status -eq 'FAIL' }).Count -eq 0) { Add-Check '-' 'unexpected error' 'FAIL' $_.Exception.Message }
} finally {
  # ------------------------------------------------------------ i. always clean up
  if ($script:Apply) {
    if ($script:State.PackageAdded -and -not $script:State.TornDown) {
      Say 'cleanup: removing the package'
      try { Invoke-Teardown } catch { Add-Check 'i' 'cleanup of the package' 'FAIL' $_.Exception.Message }
    }
    if ($script:State.CertAdded) {
      try { Invoke-CertCleanup } catch { Add-Check 'i' 'cleanup of the certificate' 'FAIL' $_.Exception.Message }
    }
  }
}

$failed = @($script:Checks | Where-Object { $_.Status -eq 'FAIL' })
$passed = ($failed.Count -eq 0)
Say ''
if ($script:Apply) {
  Write-Report $ReportPath $passed
} else {
  if ($passed) { Say 'Dry run finished: the preflight checks would pass.' }
  else { Say ('Dry run finished: the preflight would FAIL (' + $failed.Count + ' check(s)), see above.') }
  Say 'Nothing was changed. To apply, run this in an elevated PowerShell:'
  Say ('  powershell -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Run')
}
if ($passed) { exit 0 } else { exit 1 }
