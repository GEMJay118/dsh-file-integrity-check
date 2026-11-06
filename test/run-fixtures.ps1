#Requires -Version 5.0
<#
.SYNOPSIS
  Fixture / acceptance tests for engine/integrity.ps1 (dsh-file-integrity-check).

.DESCRIPTION
  Creates a self-contained fixture tree under
      %TEMP%\dsh-low-integrity-tests\<runId>\
  and exercises the engine end to end (Env / Scan / Repair), then removes the
  fixture tree again (unless -Keep is used).

  Capability detection:
    The script probes whether the current session may change integrity labels
    (icacls /setintegritylevel Medium on a throw-away probe file).
      * label writes available -> FULL suite:
          clean/, low-inherited/, low-explicit-file/, low-dir-explicit/, junction/,
          node_modules/, >260 char nested path, Chinese/space path, E1 propagation
          experiment, Repair success + restore-script round-trip.
      * label writes denied   -> SANDBOX suite:
          every object created by this session inherits Low, therefore only the
          subset that does not require Medium objects / label writes is executed:
          Scan hits, junction no-follow, -SkipDirs, long path, Chinese/space path,
          repair-failure path, snapshot/restore artifacts, read-only clean scan.
          Cases that need label writes are reported as SKIP with the reason.

  Engine invocations use Windows PowerShell 5.1 when available (the engine must be
  5.1 compatible); -EngineHost overrides the executable. An additional Env parity
  run with pwsh 7 is performed when pwsh is available.

  Output: human readable PASS/FAIL/SKIP/INFO lines plus a summary.
  Exit code: 0 = no FAIL (SKIP/INFO allowed), 1 = at least one FAIL.

.PARAMETER EnginePath
  Path to engine\integrity.ps1. Default: <repo>\engine\integrity.ps1.

.PARAMETER EngineHost
  PowerShell executable used to run the engine. Default: Windows PowerShell 5.1
  (falls back to the current process executable).

.PARAMETER Keep
  Keep the fixture directory (its path is printed).

.PARAMETER LongPathSegments
  Number of deep path segments used for the >260 char fixture. Default 8.

.PARAMETER LongPathSegmentLength
  Length of each deep path segment. Default 40.

.NOTES
  This script only touches %TEMP%\dsh-low-integrity-tests\<runId>.
  It never modifies user files outside that directory.
#>
[CmdletBinding()]
param(
    [string]$EnginePath,
    [string]$EngineHost,
    [switch]$Keep,
    [int]$LongPathSegments = 8,
    [int]$LongPathSegmentLength = 40
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Output / paths
# ---------------------------------------------------------------------------
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:ToolOutputEncoding = $null
try {
    $oemCodePage = [int][System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
    $script:ToolOutputEncoding = [System.Text.Encoding]::GetEncoding($oemCodePage)
} catch {
    $script:ToolOutputEncoding = [System.Text.Encoding]::Default
}

$script:RunId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$tempRoot = [System.IO.Path]::GetTempPath()
$script:TestTempRoot = Join-Path $tempRoot 'dsh-low-integrity-tests'
$script:BaseDir = Join-Path $script:TestTempRoot $script:RunId

$script:TestDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($script:TestDir)) {
    $script:TestDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$script:RepoRoot = Split-Path -Parent $script:TestDir
if ([string]::IsNullOrEmpty($EnginePath)) {
    $EnginePath = Join-Path (Join-Path $script:RepoRoot 'engine') 'integrity.ps1'
}
$script:EnginePath = $EnginePath
$script:KeepFixtures = [bool]$Keep
$script:LongPathSegments = $LongPathSegments
$script:LongPathSegmentLength = $LongPathSegmentLength
$script:CanWriteLabel = $false
$script:FullMode = $false
$script:Results = New-Object System.Collections.ArrayList
$script:CapabilityProbeOutput = ''
$script:EngineHostPath = ''

# Chinese fixture names are built from code points so this script stays pure ASCII.
# Windows PowerShell 5.1 reads BOM-less scripts using the ANSI code page, so a literal
# multi-byte string would be corrupted when the script is run with powershell.exe.
$script:LocalizedDirName = ([char]0x4E2D).ToString() + ([char]0x6587).ToString() + ([char]0x20).ToString() + ([char]0x76EE).ToString() + ([char]0x5F55).ToString() + ([char]0x20).ToString() + 'space'
$script:LocalizedFileName = ([char]0x6587).ToString() + ([char]0x4EF6).ToString() + ([char]0x20).ToString() + ([char]0x540D).ToString() + '.txt'

function Resolve-EngineHostPath {
    param([string]$Requested)
    if ($Requested) {
        if ([System.IO.File]::Exists($Requested)) { return $Requested }
        throw ('EngineHost not found: ' + $Requested)
    }
    try {
        $ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if ([System.IO.File]::Exists($ps51)) { return $ps51 }
    } catch { }
    try { return [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
    return 'powershell.exe'
}

function Find-Pwsh7 {
    try {
        $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            if ($command.PSObject.Properties['Source'] -and $command.Source) { return [string]$command.Source }
            if ($command.PSObject.Properties['Path'] -and $command.Path) { return [string]$command.Path }
        }
    } catch { }
    return $null
}

# ---------------------------------------------------------------------------
# Result recording
# ---------------------------------------------------------------------------
function Add-TestResult {
    param([string]$Name, [string]$Status, [string]$Detail)
    $text = ''
    if ($null -ne $Detail) { $text = [string]$Detail }
    $text = $text -replace "`r?`n", ' '
    if ($text.Length -gt 400) { $text = $text.Substring(0, 400) + '...' }
    [void]$script:Results.Add(@{ name = $Name; status = $Status; detail = $text })
    Write-Host ('[' + $Status + '] ' + $Name + $(if ($text.Length -gt 0) { ' - ' + $text } else { '' }))
}

function Add-Pass { param([string]$Name, [string]$Detail) Add-TestResult -Name $Name -Status 'PASS' -Detail $Detail }
function Add-Fail { param([string]$Name, [string]$Detail) Add-TestResult -Name $Name -Status 'FAIL' -Detail $Detail }
function Add-Skip { param([string]$Name, [string]$Detail) Add-TestResult -Name $Name -Status 'SKIP' -Detail $Detail }
function Add-Info { param([string]$Name, [string]$Detail) Add-TestResult -Name $Name -Status 'INFO' -Detail $Detail }

function Test-Assert {
    param([string]$Name, [bool]$Condition, [string]$Detail)
    if ($Condition) { Add-Pass -Name $Name -Detail $Detail }
    else { Add-Fail -Name $Name -Detail $Detail }
}

# ---------------------------------------------------------------------------
# Native label reader (independent of the engine implementation)
# ---------------------------------------------------------------------------
$script:TestNativeTypeCode = @'
using System;
using System.Runtime.InteropServices;

namespace DshIntegrityTest
{
    public static class Native
    {
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetNamedSecurityInfoW(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            IntPtr ppsidOwner,
            IntPtr ppsidGroup,
            IntPtr ppDacl,
            IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr pSecurityDescriptor,
            uint SDRevision,
            uint SecurityInformation,
            out IntPtr StringSecurityDescriptor,
            out uint StringSecurityDescriptorLen);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr hMem);

        public static string GetLabelSddl(string path, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            uint result = GetNamedSecurityInfoW(
                path,
                1,
                0x00000010,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                out securityDescriptor);
            if (result != 0)
            {
                errorCode = unchecked((int)result);
                return null;
            }
            try
            {
                IntPtr text;
                uint textLength;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        securityDescriptor,
                        1,
                        0x00000010,
                        out text,
                        out textLength))
                {
                    errorCode = Marshal.GetLastWin32Error();
                    return null;
                }
                try
                {
                    return Marshal.PtrToStringUni(text);
                }
                finally
                {
                    LocalFree(text);
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
        }

        public static string GetDaclSddl(string path, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            uint result = GetNamedSecurityInfoW(
                path,
                1,
                0x00000004,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                out securityDescriptor);
            if (result != 0)
            {
                errorCode = unchecked((int)result);
                return null;
            }
            try
            {
                IntPtr text;
                uint textLength;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        securityDescriptor,
                        1,
                        0x00000004,
                        out text,
                        out textLength))
                {
                    errorCode = Marshal.GetLastWin32Error();
                    return null;
                }
                try
                {
                    return Marshal.PtrToStringUni(text);
                }
                finally
                {
                    LocalFree(text);
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
        }
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'DshIntegrityTest.Native').Type) {
    Add-Type -TypeDefinition $script:TestNativeTypeCode -Language CSharp -ErrorAction Stop | Out-Null
}

# ---------------------------------------------------------------------------
# Path / fixture helpers
# ---------------------------------------------------------------------------
function Get-Win32Prefix {
    param([string]$Path)
    if ($Path -match '^[A-Za-z]:\\$') { return $Path }
    if ($Path.StartsWith('\\?\')) { return $Path }
    if ($Path.StartsWith('\\')) { return ('\\?\UNC\' + $Path.Substring(2)) }
    return ('\\?\' + $Path)
}

function Get-ParentDirectoryString {
    param([string]$Path)
    $index = $Path.LastIndexOf('\')
    if ($index -gt 2) { return $Path.Substring(0, $index) }
    return ''
}

function New-FixtureDirectory {
    param([string]$Path)
    [System.IO.Directory]::CreateDirectory((Get-Win32Prefix $Path)) | Out-Null
}

function New-FixtureFile {
    param([string]$Path, [string]$Content)
    $parent = Get-ParentDirectoryString $Path
    if ($parent) { New-FixtureDirectory $parent }
    [System.IO.File]::WriteAllText((Get-Win32Prefix $Path), $Content, $script:Utf8NoBom)
}

function New-FixtureJunction {
    param([string]$LinkPath, [string]$TargetPath)
    try {
        $parent = Get-ParentDirectoryString $LinkPath
        if ($parent) { New-FixtureDirectory $parent }
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
        return $true
    } catch {
        Add-Fail -Name 'fixture-junction-create' -Detail $_.Exception.Message
        return $false
    }
}

function Remove-Tree {
    param([string]$Path)
    $win32 = $Path
    if (-not $win32.StartsWith('\\?\')) { $win32 = Get-Win32Prefix $win32 }
    if ([System.IO.File]::Exists($win32)) {
        try { [System.IO.File]::SetAttributes($win32, [System.IO.FileAttributes]::Normal) } catch { }
        try { [System.IO.File]::Delete($win32) } catch { }
        return
    }
    if (-not [System.IO.Directory]::Exists($win32)) { return }
    $entries = $null
    try { $entries = [System.IO.Directory]::GetFileSystemEntries($win32) } catch { $entries = $null }
    if ($null -ne $entries) {
        foreach ($entry in $entries) {
            $attributes = [System.IO.FileAttributes]::Directory
            try { $attributes = [System.IO.File]::GetAttributes($entry) } catch { }
            $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
            $isReparse = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
            if ($isDirectory -and $isReparse) {
                try { [System.IO.Directory]::Delete($entry, $false) } catch { }
            } elseif ($isDirectory) {
                Remove-Tree -Path $entry
            } else {
                try { [System.IO.File]::SetAttributes($entry, [System.IO.FileAttributes]::Normal) } catch { }
                try { [System.IO.File]::Delete($entry) } catch { }
            }
        }
    }
    try { [System.IO.Directory]::Delete($win32, $false) } catch { }
}

# ---------------------------------------------------------------------------
# Label helpers (independent ground truth)
# ---------------------------------------------------------------------------
function ConvertFrom-IntegrityRidName {
    param([int]$Rid)
    switch ($Rid) {
        0 { return 'Untrusted' }
        4096 { return 'Low' }
        8192 { return 'Medium' }
        12288 { return 'High' }
        16384 { return 'System' }
        default { return ('S-1-16-' + $Rid) }
    }
}

function ConvertFrom-IntegritySidName {
    param([string]$Sid)
    if ([string]::IsNullOrEmpty($Sid)) { return 'None' }
    switch ($Sid) {
        'LW' { return 'Low' }
        'ME' { return 'Medium' }
        'HI' { return 'High' }
        'SI' { return 'System' }
        default {
            $m = [regex]::Match($Sid, '^S-1-16-(\d+)$')
            if ($m.Success) { return (ConvertFrom-IntegrityRidName ([int]$m.Groups[1].Value)) }
            return $Sid
        }
    }
}

function Get-LabelInfo {
    param([string]$Path)
    $errorCode = 0
    $sddl = [DshIntegrityTest.Native]::GetLabelSddl((Get-Win32Prefix $Path), [ref]$errorCode)
    if ($errorCode -ne 0) {
        return @{ ok = $false; level = 'Unknown'; explicit = $false; inherited = $false; sddl = $null; error = $errorCode }
    }
    $level = 'None'
    $explicit = $false
    $inherited = $false
    $aceMatches = [regex]::Matches($sddl, '\(ML;([^;]*);([^;]*);[^;]*;[^;]*;([^)]*)\)')
    if ($aceMatches.Count -gt 0) {
        $explicitAce = $null
        $inheritedAce = $null
        foreach ($ace in $aceMatches) {
            if ($ace.Groups[1].Value -match 'ID') {
                if ($null -eq $inheritedAce) { $inheritedAce = $ace }
            } else {
                if ($null -eq $explicitAce) { $explicitAce = $ace }
            }
        }
        $chosen = $explicitAce
        if ($null -eq $chosen) { $chosen = $inheritedAce }
        if ($null -ne $chosen) {
            $flags = $chosen.Groups[1].Value
            $level = ConvertFrom-IntegritySidName $chosen.Groups[3].Value
            $inherited = ($flags -match 'ID')
            $explicit = -not $inherited
        }
    }
    return @{ ok = $true; level = $level; explicit = $explicit; inherited = $inherited; sddl = $sddl; error = 0 }
}

function Test-AssertLabel {
    param([string]$Name, [string]$Path, [string]$ExpectedLevel, $ExpectedExplicit)
    $info = Get-LabelInfo $Path
    $condition = ($info.ok -and $info.level -eq $ExpectedLevel)
    if ($null -ne $ExpectedExplicit) { $condition = $condition -and ([bool]$info.explicit -eq [bool]$ExpectedExplicit) }
    $detail = 'level=' + $info.level + ' explicit=' + $info.explicit + ' sddl=' + $info.sddl
    Test-Assert -Name $Name -Condition $condition -Detail $detail
}

function Test-AssertNotLow {
    param([string]$Name, [string]$Path)
    $info = Get-LabelInfo $Path
    $condition = ($info.ok -and $info.level -ne 'Low')
    $detail = 'level=' + $info.level + ' explicit=' + $info.explicit + ' sddl=' + $info.sddl
    Test-Assert -Name $Name -Condition $condition -Detail $detail
}

function Get-DaclSddl {
    param([string]$Path)
    $errorCode = 0
    $sddl = [DshIntegrityTest.Native]::GetDaclSddl((Get-Win32Prefix $Path), [ref]$errorCode)
    if ($errorCode -ne 0) {
        return @{ ok = $false; sddl = $null; error = $errorCode }
    }
    return @{ ok = $true; sddl = $sddl; error = 0 }
}

# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------
function Quote-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value.Length -eq 0) { return '""' }
    $escaped = $Value
    if ($escaped.EndsWith('\')) { $escaped = $escaped + '\' }
    $escaped = $escaped -replace '"', '\"'
    return ('"' + $escaped + '"')
}

function Invoke-Process {
    param(
        [string]$Executable,
        [string]$ArgumentString,
        [System.Text.Encoding]$OutputEncoding
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $ArgumentString
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    if ($null -ne $OutputEncoding) {
        try { $startInfo.StandardOutputEncoding = $OutputEncoding } catch { }
        try { $startInfo.StandardErrorEncoding = $OutputEncoding } catch { }
    }
    $process = $null
    $stdout = ''
    $stderr = ''
    $exitCode = -1
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } catch {
        return @{ exitCode = -1; stdout = ''; stderr = $_.Exception.Message }
    } finally {
        if ($null -ne $process) { try { $process.Dispose() } catch { } }
    }
    return @{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr }
}

function Get-IcaclsExecutable {
    param([string]$Candidate)
    if ([string]::IsNullOrEmpty($Candidate)) { $Candidate = 'icacls.exe' }
    if ([System.IO.File]::Exists($Candidate)) { return $Candidate }
    try {
        $command = Get-Command $Candidate -ErrorAction Stop | Select-Object -First 1
        if ($command) {
            if ($command.PSObject.Properties['Source'] -and $command.Source) { return [string]$command.Source }
            if ($command.PSObject.Properties['Path'] -and $command.Path) { return [string]$command.Path }
        }
    } catch { }
    $fallback = Join-Path $env:SystemRoot 'System32\icacls.exe'
    if ([System.IO.File]::Exists($fallback)) { return $fallback }
    return $Candidate
}

function Set-FixtureLabel {
    param([string]$Path, [string]$LevelSpecification)
    $toolPath = $Path
    if ($Path.Length -ge 255 -or $Path.StartsWith('\\')) { $toolPath = Get-Win32Prefix $Path }
    $arguments = (Quote-ProcessArgument $toolPath) + ' /setintegritylevel ' + (Quote-ProcessArgument $LevelSpecification)
    $call = Invoke-Process -Executable $script:IcaclsPath -ArgumentString $arguments -OutputEncoding $script:ToolOutputEncoding
    return @{ exitCode = $call.exitCode; output = (($call.stdout + "`r`n" + $call.stderr).Trim()) }
}

function Invoke-IcaclsOnPath {
    param([string]$Path, [string]$Arguments)
    $toolPath = $Path
    if ($Path.Length -ge 255 -or $Path.StartsWith('\\')) { $toolPath = Get-Win32Prefix $Path }
    $argumentLine = (Quote-ProcessArgument $toolPath) + ' ' + $Arguments
    $call = Invoke-Process -Executable $script:IcaclsPath -ArgumentString $argumentLine -OutputEncoding $script:ToolOutputEncoding
    return @{ exitCode = $call.exitCode; output = (($call.stdout + "`r`n" + $call.stderr).Trim()) }
}

function Invoke-Engine {
    param([string[]]$EngineArguments, [string]$HostPath)
    $executable = $script:EngineHostPath
    if ($HostPath) { $executable = $HostPath }
    $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $script:EnginePath)
    foreach ($argument in $EngineArguments) {
        $argumentLine = $argumentLine + ' ' + (Quote-ProcessArgument ([string]$argument))
    }
    $call = Invoke-Process -Executable $executable -ArgumentString $argumentLine -OutputEncoding $script:Utf8NoBom
    $events = New-Object System.Collections.ArrayList
    $badLines = New-Object System.Collections.ArrayList
    $lines = @()
    if ($null -ne $call.stdout) {
        $lines = [regex]::Split($call.stdout, "`r?`n")
    }
    foreach ($line in $lines) {
        $trimmed = [string]$line
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.Trim().Length -eq 0) { continue }
        try {
            $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop
            [void]$events.Add($parsed)
        } catch {
            [void]$badLines.Add($trimmed)
        }
    }
    return @{
        exitCode = $call.exitCode
        stdout   = $call.stdout
        stderr   = $call.stderr
        events   = $events
        badLines = $badLines
        host     = $executable
    }
}

function Get-EventsOfType {
    param($Run, [string]$Type)
    return @($Run.events | Where-Object { $_.type -eq $Type })
}

function Get-ResultEvent {
    param($Run)
    $list = @($Run.events | Where-Object { $_.type -eq 'result' })
    if ($list.Count -eq 0) { return $null }
    return $list[$list.Count - 1]
}

function Test-EventContract {
    param($Run, [string]$NamePrefix)
    Test-Assert -Name ($NamePrefix + '-jsonl-well-formed') -Condition ($Run.badLines.Count -eq 0) -Detail ('non-JSON lines: ' + $Run.badLines.Count)
    if ($Run.stdout) {
        $firstChar = $Run.stdout.Substring(0, 1)
        $hasBom = ([int][char]$firstChar -eq 65279)
        Test-Assert -Name ($NamePrefix + '-jsonl-no-bom') -Condition (-not $hasBom) -Detail ('starts with BOM: ' + $hasBom)
    }
    $invalidTypes = New-Object System.Collections.ArrayList
    $allowed = @('env', 'progress', 'hit', 'error', 'result', 'fatal')
    foreach ($event in $Run.events) {
        $type = [string]$event.type
        if ($allowed -notcontains $type) { [void]$invalidTypes.Add($type) }
    }
    Test-Assert -Name ($NamePrefix + '-event-types') -Condition ($invalidTypes.Count -eq 0) -Detail ('unexpected types: ' + ($invalidTypes -join ','))
}

function Get-HitMap {
    param($HitEvents)
    $map = @{}
    foreach ($hit in $HitEvents) {
        $map[([string]$hit.path).ToLowerInvariant()] = $hit
    }
    return $map
}

function Get-ExpectedHitMap {
    param($ExpectedHits)
    $map = @{}
    foreach ($entry in $ExpectedHits) {
        $map[([string]$entry.path).ToLowerInvariant()] = $entry
    }
    return $map
}

function Test-HitSet {
    param([string]$NamePrefix, $HitEvents, $ExpectedHits)
    $hitMap = Get-HitMap $HitEvents
    $expectedMap = Get-ExpectedHitMap $ExpectedHits
    $missing = New-Object System.Collections.ArrayList
    foreach ($key in $expectedMap.Keys) {
        if (-not $hitMap.ContainsKey($key)) { [void]$missing.Add($expectedMap[$key].path) }
    }
    $extra = New-Object System.Collections.ArrayList
    foreach ($key in $hitMap.Keys) {
        if (-not $expectedMap.ContainsKey($key)) { [void]$extra.Add($hitMap[$key].path) }
    }
    Test-Assert -Name ($NamePrefix + '-hit-count') -Condition ($HitEvents.Count -eq $ExpectedHits.Count) -Detail ('expected ' + $ExpectedHits.Count + ', got ' + $HitEvents.Count)
    Test-Assert -Name ($NamePrefix + '-hit-set-missing') -Condition ($missing.Count -eq 0) -Detail ('missing: ' + (($missing | Select-Object -First 5) -join '; '))
    Test-Assert -Name ($NamePrefix + '-hit-set-extra') -Condition ($extra.Count -eq 0) -Detail ('extra: ' + (($extra | Select-Object -First 5) -join '; '))

    $flagMismatches = New-Object System.Collections.ArrayList
    foreach ($key in $expectedMap.Keys) {
        if ($hitMap.ContainsKey($key)) {
            $expectedExplicit = [bool]$expectedMap[$key].explicit
            $actualExplicit = [bool]$hitMap[$key].explicit
            if ($expectedExplicit -ne $actualExplicit) {
                [void]$flagMismatches.Add($hitMap[$key].path + ' expected explicit=' + $expectedExplicit + ' got ' + $actualExplicit)
            }
        }
    }
    Test-Assert -Name ($NamePrefix + '-explicit-flags') -Condition ($flagMismatches.Count -eq 0) -Detail (($flagMismatches | Select-Object -First 5) -join '; ')
}

function Test-ResultContract {
    param($Run, [string]$NamePrefix)
    $result = Get-ResultEvent $Run
    Test-Assert -Name ($NamePrefix + '-has-result') -Condition ($null -ne $result) -Detail ''
    if ($null -eq $result) { return }
    $required = @('type', 'mode', 'root', 'rootLabel', 'scanned', 'hits', 'explicitCount', 'inheritedCount', 'errors', 'truncated', 'engineVersion', 'durationMs')
    $missingProperties = New-Object System.Collections.ArrayList
    foreach ($property in $required) {
        if ($null -eq $result.PSObject.Properties[$property]) { [void]$missingProperties.Add($property) }
    }
    Test-Assert -Name ($NamePrefix + '-result-fields') -Condition ($missingProperties.Count -eq 0) -Detail ('missing: ' + ($missingProperties -join ','))
    Test-Assert -Name ($NamePrefix + '-result-version') -Condition ([string]$result.engineVersion -eq '0.1.0') -Detail ('engineVersion=' + [string]$result.engineVersion)
    Test-Assert -Name ($NamePrefix + '-result-counts') -Condition (([int]$result.explicitCount + [int]$result.inheritedCount) -eq [int]$result.hits) -Detail ('explicit=' + [int]$result.explicitCount + ' inherited=' + [int]$result.inheritedCount + ' hits=' + [int]$result.hits)
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
function Initialize-FullFixtures {
    $fixtures = @{}
    $fx = Join-Path $script:BaseDir 'fixtures'
    $fixtures.root = $fx
    New-FixtureDirectory $fx

    # clean/ built from default (unlabeled / Medium) objects
    $clean = Join-Path $fx 'clean'
    New-FixtureDirectory $clean
    New-FixtureDirectory (Join-Path $clean 'sub')
    New-FixtureFile (Join-Path $clean 'clean-file.txt') 'clean'
    New-FixtureFile (Join-Path $clean 'sub\clean-sub.txt') 'clean'
    $fixtures.cleanDir = $clean
    $fixtures.cleanFile = Join-Path $clean 'clean-file.txt'

    # low-inherited/
    $lowInherited = Join-Path $fx 'low-inherited'
    New-FixtureDirectory $lowInherited
    New-FixtureDirectory (Join-Path $lowInherited 'child-dir')
    New-FixtureFile (Join-Path $lowInherited 'child-file.txt') 'low'
    New-FixtureFile (Join-Path $lowInherited 'child-dir\nested.txt') 'low'
    $lowChildren = New-Object System.Collections.ArrayList
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-dir'))
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-file.txt'))
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-dir\nested.txt'))
    $fixtures.lowInherited = $lowInherited
    $fixtures.lowInheritedChildren = @($lowChildren)

    # >260 char nested path under the low-inherited root
    $deep = $lowInherited
    $deepDirectories = New-Object System.Collections.ArrayList
    for ($index = 0; $index -lt $script:LongPathSegments; $index++) {
        $segment = ('d' * $script:LongPathSegmentLength) + [string]$index
        $deep = Join-Path $deep $segment
        New-FixtureDirectory $deep
        [void]$deepDirectories.Add($deep)
    }
    $deepFile = Join-Path $deep 'deep-file.txt'
    New-FixtureFile $deepFile 'deep'
    $fixtures.deepDirectories = @($deepDirectories)
    $fixtures.deepFile = $deepFile

    # low-explicit-file/
    $explicitFileDirectory = Join-Path $fx 'low-explicit-file'
    New-FixtureDirectory $explicitFileDirectory
    $explicitFile = Join-Path $explicitFileDirectory 'explicit-low.txt'
    New-FixtureFile $explicitFile 'low'
    $fixtures.explicitFile = $explicitFile

    # low-dir-explicit/
    $explicitDir = Join-Path $fx 'low-dir-explicit'
    New-FixtureDirectory $explicitDir
    New-FixtureFile (Join-Path $explicitDir 'inherited-child.txt') 'low'
    $fixtures.explicitDir = $explicitDir
    $fixtures.explicitDirChild = Join-Path $explicitDir 'inherited-child.txt'

    # junction/ -> Low target outside the scan root
    $junctionDir = Join-Path $fx 'junction'
    New-FixtureDirectory $junctionDir
    $target = Join-Path $script:BaseDir 'targets\low-target'
    New-FixtureDirectory $target
    New-FixtureFile (Join-Path $target 'target-file.txt') 'low'
    New-FixtureDirectory (Join-Path $target 'target-sub')
    New-FixtureFile (Join-Path $target 'target-sub\target-sub-file.txt') 'low'
    $fixtures.junctionDir = $junctionDir
    $fixtures.junctionLink = Join-Path $junctionDir 'link'
    $fixtures.targetDir = $target
    $fixtures.targetFile = Join-Path $target 'target-file.txt'
    $fixtures.targetSubFile = Join-Path $target 'target-sub\target-sub-file.txt'

    # node_modules/ with a Low file that must be skipped
    $nodeModules = Join-Path $fx 'node_modules'
    New-FixtureDirectory $nodeModules
    $nodeModulesFile = Join-Path $nodeModules 'low-inside-node-modules.txt'
    New-FixtureFile $nodeModulesFile 'low'
    $fixtures.nodeModulesDir = $nodeModules
    $fixtures.nodeModulesFile = $nodeModulesFile

    # Chinese + space path
    $localizedDir = Join-Path $fx $script:LocalizedDirName
    New-FixtureDirectory $localizedDir
    $localizedFile = Join-Path $localizedDir $script:LocalizedFileName
    New-FixtureFile $localizedFile 'low'
    $fixtures.localizedDir = $localizedDir
    $fixtures.localizedFile = $localizedFile

    # ---- labels: only objects that must be Low ---------------------------
    $labelFailures = New-Object System.Collections.ArrayList
    $steps = @(
        @{ Path = $lowInherited; Spec = '(OI)(CI)Low' },
        @{ Path = $explicitFile; Spec = 'Low' },
        @{ Path = $explicitDir; Spec = '(OI)(CI)Low' },
        @{ Path = $target; Spec = '(OI)(CI)Low' },
        @{ Path = $nodeModulesFile; Spec = 'Low' },
        @{ Path = $localizedDir; Spec = '(OI)(CI)Low' }
    )
    foreach ($step in $steps) {
        $call = Set-FixtureLabel -Path $step.Path -LevelSpecification $step.Spec
        if ($call.exitCode -ne 0) {
            [void]$labelFailures.Add($step.Path + ' :: ' + $call.output)
        }
    }
    $fixtures.labelFailures = @($labelFailures)
    $fixtures.junctionCreated = New-FixtureJunction -LinkPath $fixtures.junctionLink -TargetPath $target
    return $fixtures
}

function Initialize-SandboxFixtures {
    $fixtures = @{}
    $fx = Join-Path $script:BaseDir 'fixtures'
    $fixtures.root = $fx
    New-FixtureDirectory $fx

    $lowInherited = Join-Path $fx 'low-inherited'
    New-FixtureDirectory $lowInherited
    New-FixtureDirectory (Join-Path $lowInherited 'child-dir')
    New-FixtureFile (Join-Path $lowInherited 'child-file.txt') 'low'
    New-FixtureFile (Join-Path $lowInherited 'child-dir\nested.txt') 'low'
    $lowChildren = New-Object System.Collections.ArrayList
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-dir'))
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-file.txt'))
    [void]$lowChildren.Add((Join-Path $lowInherited 'child-dir\nested.txt'))
    $fixtures.lowInherited = $lowInherited
    $fixtures.lowInheritedChildren = @($lowChildren)

    $deep = $lowInherited
    $deepDirectories = New-Object System.Collections.ArrayList
    for ($index = 0; $index -lt $script:LongPathSegments; $index++) {
        $segment = ('d' * $script:LongPathSegmentLength) + [string]$index
        $deep = Join-Path $deep $segment
        New-FixtureDirectory $deep
        [void]$deepDirectories.Add($deep)
    }
    $deepFile = Join-Path $deep 'deep-file.txt'
    New-FixtureFile $deepFile 'deep'
    $fixtures.deepDirectories = @($deepDirectories)
    $fixtures.deepFile = $deepFile

    $junctionDir = Join-Path $fx 'junction'
    New-FixtureDirectory $junctionDir
    $target = Join-Path $script:BaseDir 'targets\low-target'
    New-FixtureDirectory $target
    New-FixtureFile (Join-Path $target 'target-file.txt') 'low'
    New-FixtureDirectory (Join-Path $target 'target-sub')
    New-FixtureFile (Join-Path $target 'target-sub\target-sub-file.txt') 'low'
    $fixtures.junctionDir = $junctionDir
    $fixtures.junctionLink = Join-Path $junctionDir 'link'
    $fixtures.targetDir = $target
    $fixtures.targetFile = Join-Path $target 'target-file.txt'
    $fixtures.targetSubFile = Join-Path $target 'target-sub\target-sub-file.txt'

    $nodeModules = Join-Path $fx 'node_modules'
    New-FixtureDirectory $nodeModules
    $nodeModulesFile = Join-Path $nodeModules 'low-inside-node-modules.txt'
    New-FixtureFile $nodeModulesFile 'low'
    $fixtures.nodeModulesDir = $nodeModules
    $fixtures.nodeModulesFile = $nodeModulesFile

    $localizedDir = Join-Path $fx $script:LocalizedDirName
    New-FixtureDirectory $localizedDir
    $localizedFile = Join-Path $localizedDir $script:LocalizedFileName
    New-FixtureFile $localizedFile 'low'
    $fixtures.localizedDir = $localizedDir
    $fixtures.localizedFile = $localizedFile

    $fixtures.labelFailures = @()
    $fixtures.junctionCreated = New-FixtureJunction -LinkPath $fixtures.junctionLink -TargetPath $target
    return $fixtures
}

function Get-FullExpectedHits {
    param($Fixtures)
    $expected = New-Object System.Collections.ArrayList
    [void]$expected.Add(@{ path = $Fixtures.lowInherited; explicit = $true })
    foreach ($child in $Fixtures.lowInheritedChildren) {
        [void]$expected.Add(@{ path = $child; explicit = $false })
    }
    foreach ($directory in $Fixtures.deepDirectories) {
        [void]$expected.Add(@{ path = $directory; explicit = $false })
    }
    [void]$expected.Add(@{ path = $Fixtures.deepFile; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.explicitFile; explicit = $true })
    [void]$expected.Add(@{ path = $Fixtures.explicitDir; explicit = $true })
    [void]$expected.Add(@{ path = $Fixtures.explicitDirChild; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.localizedDir; explicit = $true })
    [void]$expected.Add(@{ path = $Fixtures.localizedFile; explicit = $false })
    return $expected
}

function Get-SandboxExpectedHits {
    param($Fixtures)
    $expected = New-Object System.Collections.ArrayList
    [void]$expected.Add(@{ path = $Fixtures.root; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.lowInherited; explicit = $false })
    foreach ($child in $Fixtures.lowInheritedChildren) {
        [void]$expected.Add(@{ path = $child; explicit = $false })
    }
    foreach ($directory in $Fixtures.deepDirectories) {
        [void]$expected.Add(@{ path = $directory; explicit = $false })
    }
    [void]$expected.Add(@{ path = $Fixtures.deepFile; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.junctionDir; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.junctionLink; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.localizedDir; explicit = $false })
    [void]$expected.Add(@{ path = $Fixtures.localizedFile; explicit = $false })
    return $expected
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
function Test-EnvMode {
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Env')
    Test-Assert -Name 'env-exit-code' -Condition ($run.exitCode -eq 0) -Detail ('exit=' + $run.exitCode)
    Test-EventContract -Run $run -NamePrefix 'env'
    $events = @(Get-EventsOfType $run 'env')
    Test-Assert -Name 'env-has-event' -Condition ($events.Count -eq 1) -Detail ('count=' + $events.Count)
    if ($events.Count -lt 1) { return $null }
    $envInfo = $events[0]
    $required = @('user', 'integrity', 'powershellVersion', 'icaclsPath', 'canWriteLabel')
    $missingProperties = New-Object System.Collections.ArrayList
    foreach ($property in $required) {
        if ($null -eq $envInfo.PSObject.Properties[$property]) { [void]$missingProperties.Add($property) }
    }
    Test-Assert -Name 'env-fields' -Condition ($missingProperties.Count -eq 0) -Detail ('missing: ' + ($missingProperties -join ','))
    $allowedIntegrity = @('Low', 'Medium', 'High', 'System', 'Untrusted', 'Protected', 'Unknown')
    Test-Assert -Name 'env-integrity' -Condition ($allowedIntegrity -contains [string]$envInfo.integrity) -Detail ('integrity=' + [string]$envInfo.integrity)
    Test-Assert -Name 'env-can-write-label' -Condition ([bool]$envInfo.canWriteLabel -eq [bool]$script:CanWriteLabel) -Detail ('reported=' + [bool]$envInfo.canWriteLabel + ' probe=' + [bool]$script:CanWriteLabel)
    Test-Assert -Name 'env-icacls-exists' -Condition ([System.IO.File]::Exists([string]$envInfo.icaclsPath)) -Detail ('icaclsPath=' + [string]$envInfo.icaclsPath)
    Test-Assert -Name 'env-powershell-version' -Condition (-not [string]::IsNullOrEmpty([string]$envInfo.powershellVersion)) -Detail ('powershellVersion=' + [string]$envInfo.powershellVersion)
    return $envInfo
}

function Test-ScanSuite {
    param($Fixtures, $ExpectedHits, [string]$Prefix)
    $arguments = @('-Mode', 'Scan', '-Root', $Fixtures.root, '-SkipDirs', 'node_modules', '-Json')
    $run = Invoke-Engine -EngineArguments $arguments
    Test-EventContract -Run $run -NamePrefix $Prefix
    Test-Assert -Name ($Prefix + '-exit-code') -Condition ($run.exitCode -eq 2) -Detail ('exit=' + $run.exitCode)
    Test-ResultContract -Run $run -NamePrefix $Prefix
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        Test-Assert -Name ($Prefix + '-result-mode') -Condition ([string]$result.mode -eq 'scan') -Detail ('mode=' + [string]$result.mode)
        Test-Assert -Name ($Prefix + '-result-root') -Condition (([string]$result.root).ToLowerInvariant().TrimEnd('\') -eq $Fixtures.root.ToLowerInvariant().TrimEnd('\')) -Detail ('root=' + [string]$result.root)
    }
    $hitEvents = @(Get-EventsOfType $run 'hit')
    Test-HitSet -NamePrefix $Prefix -HitEvents $hitEvents -ExpectedHits $ExpectedHits

    $progressEvents = @(Get-EventsOfType $run 'progress')
    Test-Assert -Name ($Prefix + '-progress-present') -Condition ($progressEvents.Count -gt 0) -Detail ('count=' + $progressEvents.Count)
    $allowedPhases = @('enumerate', 'read', 'repair', 'verify')
    $badPhases = New-Object System.Collections.ArrayList
    foreach ($progress in $progressEvents) {
        if ($allowedPhases -notcontains [string]$progress.phase) { [void]$badPhases.Add([string]$progress.phase) }
    }
    Test-Assert -Name ($Prefix + '-progress-phases') -Condition ($badPhases.Count -eq 0) -Detail ('unexpected: ' + ($badPhases -join ','))
    return @{ run = $run; result = $result; hits = $hitEvents }
}

function Test-JunctionNoFollow {
    param($ScanOutcome, $Fixtures, [string]$Prefix)
    $linkLower = ([string]$Fixtures.junctionLink).ToLowerInvariant()
    $targetLower = ([string]$Fixtures.targetDir).ToLowerInvariant()
    $followedPaths = New-Object System.Collections.ArrayList
    foreach ($hit in $ScanOutcome.hits) {
        $pathLower = ([string]$hit.path).ToLowerInvariant()
        if ($pathLower.StartsWith($linkLower + '\')) { [void]$followedPaths.Add([string]$hit.path); continue }
        if ($pathLower -eq $targetLower -or $pathLower.StartsWith($targetLower + '\')) { [void]$followedPaths.Add([string]$hit.path) }
    }
    Test-Assert -Name ($Prefix + '-junction-not-followed') -Condition ($followedPaths.Count -eq 0) -Detail ('paths reached through junction: ' + (($followedPaths | Select-Object -First 5) -join '; '))
    Test-AssertLabel -Name ($Prefix + '-junction-target-is-low') -Path $Fixtures.targetFile -ExpectedLevel 'Low' -ExpectedExplicit $null
}

function Test-SkipDirs {
    param($ScanOutcome, $Fixtures, [string]$Prefix)
    $bad = New-Object System.Collections.ArrayList
    foreach ($hit in $ScanOutcome.hits) {
        $pathLower = ([string]$hit.path).ToLowerInvariant()
        if ($pathLower -eq ([string]$Fixtures.nodeModulesDir).ToLowerInvariant()) { [void]$bad.Add([string]$hit.path); continue }
        if ($pathLower.StartsWith(([string]$Fixtures.nodeModulesDir).ToLowerInvariant() + '\')) { [void]$bad.Add([string]$hit.path) }
    }
    Test-Assert -Name ($Prefix + '-node-modules-skipped') -Condition ($bad.Count -eq 0) -Detail ('hits inside node_modules: ' + (($bad | Select-Object -First 5) -join '; '))
    Test-AssertLabel -Name ($Prefix + '-node-modules-file-is-low') -Path $Fixtures.nodeModulesFile -ExpectedLevel 'Low' -ExpectedExplicit $null
}

function Test-LongPath {
    param($ScanOutcome, $Fixtures, [string]$Prefix)
    $hitMap = Get-HitMap $ScanOutcome.hits
    $key = ([string]$Fixtures.deepFile).ToLowerInvariant()
    Test-Assert -Name ($Prefix + '-long-path-hit') -Condition ($hitMap.ContainsKey($key)) -Detail ('length=' + ([string]$Fixtures.deepFile).Length)
    Test-Assert -Name ($Prefix + '-long-path-over-260') -Condition (([string]$Fixtures.deepFile).Length -gt 260) -Detail ('length=' + ([string]$Fixtures.deepFile).Length)
    if ($hitMap.ContainsKey($key)) {
        Test-Assert -Name ($Prefix + '-long-path-exact') -Condition ([string]$hitMap[$key].path -eq [string]$Fixtures.deepFile) -Detail ('got=' + [string]$hitMap[$key].path)
    }
}

function Test-LocalizedRoot {
    param($Fixtures, [string]$Prefix)
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $Fixtures.localizedDir, '-SkipDirs', 'node_modules')
    Test-EventContract -Run $run -NamePrefix ($Prefix + '-localized')
    Test-Assert -Name ($Prefix + '-localized-exit-code') -Condition ($run.exitCode -eq 2) -Detail ('exit=' + $run.exitCode)
    $hitEvents = @(Get-EventsOfType $run 'hit')
    $expected = New-Object System.Collections.ArrayList
    [void]$expected.Add(@{ path = $Fixtures.localizedDir; explicit = $script:FullMode })
    [void]$expected.Add(@{ path = $Fixtures.localizedFile; explicit = $false })
    Test-HitSet -NamePrefix ($Prefix + '-localized') -HitEvents $hitEvents -ExpectedHits $expected
    $hitMap = Get-HitMap $hitEvents
    $key = ([string]$Fixtures.localizedFile).ToLowerInvariant()
    Test-Assert -Name ($Prefix + '-localized-json-path') -Condition ($hitMap.ContainsKey($key)) -Detail ('path=' + [string]$Fixtures.localizedFile)
}

function Test-FatalMissingRoot {
    $missing = Join-Path $script:BaseDir ('missing-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $missing)
    Test-Assert -Name 'fatal-missing-root-exit' -Condition ($run.exitCode -eq 3) -Detail ('exit=' + $run.exitCode)
    $fatalEvents = @(Get-EventsOfType $run 'fatal')
    Test-Assert -Name 'fatal-missing-root-event' -Condition ($fatalEvents.Count -eq 1) -Detail ('count=' + $fatalEvents.Count)
    if ($fatalEvents.Count -gt 0) {
        Test-Assert -Name 'fatal-missing-root-code' -Condition ([string]$fatalEvents[0].code -eq 'root-not-found') -Detail ('code=' + [string]$fatalEvents[0].code)
    }
}

function Test-ReadOnlyCleanScan {
    if ($script:FullMode) { return }
    $candidates = @(
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\en-US'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Management')
    )
    $candidate = $null
    foreach ($path in $candidates) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $info = Get-LabelInfo $path
        if (-not $info.ok) { continue }
        if ($info.level -eq 'Low') { continue }
        $candidate = $path
        break
    }
    if ($null -eq $candidate) {
        Add-Skip -Name 'clean-scan-readonly' -Detail 'no readable non-Low reference directory available in this sandbox'
        return
    }
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $candidate, '-SkipDirs', 'node_modules')
    Test-EventContract -Run $run -NamePrefix 'clean-readonly'
    $result = Get-ResultEvent $run
    $hits = @(Get-EventsOfType $run 'hit')
    $condition = ($run.exitCode -eq 0) -and ($hits.Count -eq 0)
    if ($null -ne $result) { $condition = $condition -and ([string]$result.rootLabel -ne 'Low') }
    Test-Assert -Name 'clean-scan-readonly' -Condition $condition -Detail ('dir=' + $candidate + ' exit=' + $run.exitCode + ' hits=' + $hits.Count + ' errors=' + (@(Get-EventsOfType $run 'error')).Count)
}

function Test-RepairFailure {
    param($Fixtures)
    $repairTarget = Join-Path $script:BaseDir 'repair-fail'
    New-FixtureDirectory $repairTarget
    New-FixtureFile (Join-Path $repairTarget 'fail-one.txt') 'low'
    New-FixtureFile (Join-Path $repairTarget 'fail-two.txt') 'low'
    $targetSddlBefore = ''
    if ($null -ne $Fixtures.targetFile) {
        $targetInfoBefore = Get-LabelInfo $Fixtures.targetFile
        $targetSddlBefore = [string]$targetInfoBefore.sddl
    }

    $scanRun = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $repairTarget)
    $scanHits = @(Get-EventsOfType $scanRun 'hit')

    $dataDir = Join-Path $script:BaseDir 'data-repair-fail'
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Repair', '-Root', $repairTarget, '-SkipDirs', 'node_modules', '-DataDir', $dataDir)
    Test-EventContract -Run $run -NamePrefix 'repair-fail'
    Test-Assert -Name 'repair-fail-exit-code' -Condition ($run.exitCode -eq 2) -Detail ('exit=' + $run.exitCode)
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        $failedArray = @($result.failed)
        Test-Assert -Name 'repair-fail-result-failed-nonempty' -Condition ($failedArray.Count -gt 0) -Detail ('failed=' + $failedArray.Count)
        Test-Assert -Name 'repair-fail-result-remaining' -Condition ([int]$result.remaining -gt 0) -Detail ('remaining=' + [int]$result.remaining)
        $failedContract = $true
        foreach ($entry in $failedArray) {
            if ($null -eq $entry.PSObject.Properties['path'] -or $null -eq $entry.PSObject.Properties['message'] -or $null -eq $entry.PSObject.Properties['output']) { $failedContract = $false }
        }
        Test-Assert -Name 'repair-fail-failed-fields' -Condition $failedContract -Detail ('failed entries=' + $failedArray.Count)
        Test-Assert -Name 'repair-fail-snapshot-exists' -Condition ([System.IO.File]::Exists([string]$result.snapshotPath)) -Detail ('snapshotPath=' + [string]$result.snapshotPath)
        Test-Assert -Name 'repair-fail-restore-exists' -Condition ([System.IO.File]::Exists([string]$result.restorePath)) -Detail ('restorePath=' + [string]$result.restorePath)

        $snapshotCheck = Test-SnapshotDocument -SnapshotPath ([string]$result.snapshotPath) -ExpectedHitCount $scanHits.Count -Prefix 'repair-fail'
        Test-Assert -Name 'repair-fail-snapshot-document' -Condition $snapshotCheck -Detail ('hitCount expected=' + $scanHits.Count)
        Test-Assert -Name 'repair-fail-restore-parse' -Condition (Test-ScriptParses -Path ([string]$result.restorePath)) -Detail ('restorePath=' + [string]$result.restorePath)
    }
    $repairErrors = @(Get-EventsOfType $run 'error' | Where-Object { [string]$_.phase -eq 'repair' })
    $withOutput = @($repairErrors | Where-Object { -not [string]::IsNullOrEmpty([string]$_.output) })
    Test-Assert -Name 'repair-fail-error-events' -Condition ($repairErrors.Count -gt 0) -Detail ('repair error events=' + $repairErrors.Count)
    Test-Assert -Name 'repair-fail-error-output' -Condition ($withOutput.Count -gt 0) -Detail ('with output=' + $withOutput.Count)

    $rescanRun = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $repairTarget)
    Test-Assert -Name 'repair-fail-rescan-still-low' -Condition ($rescanRun.exitCode -eq 2) -Detail ('exit=' + $rescanRun.exitCode)

    if ($null -ne $Fixtures.targetFile) {
        $targetInfoAfter = Get-LabelInfo $Fixtures.targetFile
        Test-Assert -Name 'repair-fail-non-target-unchanged' -Condition ([string]$targetInfoAfter.sddl -eq $targetSddlBefore) -Detail ('before=' + $targetSddlBefore + ' after=' + [string]$targetInfoAfter.sddl)
    }
}

function Test-PinvokeFallback {
    $target = Join-Path $script:BaseDir 'pinvoke-target'
    New-FixtureDirectory $target
    New-FixtureFile (Join-Path $target 'pinvoke-child.txt') 'low'
    $setLow = Set-FixtureLabel -Path $target -LevelSpecification '(OI)(CI)Low'
    Test-Assert -Name 'pinvoke-fallback-setup-low' -Condition ($setLow.exitCode -eq 0) -Detail $setLow.output
    if ($setLow.exitCode -ne 0) { return }

    $dataDir = Join-Path $script:BaseDir 'data-pinvoke'
    # A .cmd cannot be started with UseShellExecute=false, so the engine's icacls
    # call fails and its SetNamedSecurityInfoW fallback must take over.
    $fakeIcacls = Join-Path $script:BaseDir 'fake-icacls.cmd'
    New-FixtureFile $fakeIcacls ("@echo off`r`nexit /b 5`r`n")
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Repair', '-Root', $target, '-SkipDirs', 'node_modules', '-DataDir', $dataDir, '-IcaclsPath', $fakeIcacls)
    Test-EventContract -Run $run -NamePrefix 'pinvoke-fallback'
    Test-Assert -Name 'pinvoke-fallback-exit' -Condition ($run.exitCode -eq 0) -Detail ('exit=' + $run.exitCode)
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        Test-Assert -Name 'pinvoke-fallback-fixed' -Condition ([int]$result.fixed -gt 0) -Detail ('fixed=' + [int]$result.fixed)
        Test-Assert -Name 'pinvoke-fallback-remaining' -Condition ([int]$result.remaining -eq 0) -Detail ('remaining=' + [int]$result.remaining)
        Test-Assert -Name 'pinvoke-fallback-failed-empty' -Condition (@($result.failed).Count -eq 0) -Detail ('failed=' + @($result.failed).Count)
        $methods = $result.methods
        $pinvokeCount = 0
        $icaclsCount = 0
        if ($null -ne $methods -and $null -ne $methods.PSObject.Properties['pinvoke']) { $pinvokeCount = [int]$methods.pinvoke }
        if ($null -ne $methods -and $null -ne $methods.PSObject.Properties['icacls']) { $icaclsCount = [int]$methods.icacls }
        Test-Assert -Name 'pinvoke-fallback-method' -Condition ($pinvokeCount -gt 0) -Detail ('methods.pinvoke=' + $pinvokeCount + ' methods.icacls=' + $icaclsCount + ' fixed=' + [int]$result.fixed + ' remaining=' + [int]$result.remaining)
    }
    $rescan = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $target, '-SkipDirs', 'node_modules')
    Test-Assert -Name 'pinvoke-fallback-rescan' -Condition ($rescan.exitCode -eq 0) -Detail ('exit=' + $rescan.exitCode)
}

function Test-RepairNeedsGrant {
    $dir = Join-Path $script:BaseDir 'needs-grant'
    New-FixtureDirectory $dir
    $file = Join-Path $dir 'needs-grant.txt'
    New-FixtureFile $file 'low'
    $userSid = ''
    try { $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $userSid = '' }
    if ([string]::IsNullOrEmpty($userSid)) {
        Add-Skip -Name 'repair-needs-grant' -Detail 'current user SID unavailable'
        return
    }

    # 1) explicit Low while the inherited DACL still allows the label write
    $setLow = Set-FixtureLabel -Path $file -LevelSpecification 'Low'
    Test-Assert -Name 'needs-grant-setup-low' -Condition ($setLow.exitCode -eq 0) -Detail $setLow.output
    if ($setLow.exitCode -ne 0) { return }

    # 2) strip inherited + explicit permissions so the owner has no WRITE_OWNER
    $stripInheritance = Invoke-IcaclsOnPath -Path $file -Arguments '/inheritance:r'
    $removeExplicit = Invoke-IcaclsOnPath -Path $file -Arguments ('/remove:g *' + $userSid)
    if ($stripInheritance.exitCode -ne 0 -or $removeExplicit.exitCode -ne 0) {
        Add-Skip -Name 'repair-needs-grant' -Detail ('could not construct an ACL-less fixture: inheritance=' + $stripInheritance.exitCode + ' remove=' + $removeExplicit.exitCode + ' ' + $stripInheritance.output + ' ' + $removeExplicit.output)
        return
    }
    $labelAfterStrip = Get-LabelInfo $file
    Test-Assert -Name 'needs-grant-setup-explicit-low' -Condition ($labelAfterStrip.ok -and $labelAfterStrip.level -eq 'Low' -and [bool]$labelAfterStrip.explicit) -Detail ('level=' + $labelAfterStrip.level + ' explicit=' + $labelAfterStrip.explicit)
    $daclBefore = Get-DaclSddl $file
    Test-Assert -Name 'needs-grant-setup-dacl-read' -Condition ($daclBefore.ok) -Detail ('dacl=' + [string]$daclBefore.sddl)
    if (-not $daclBefore.ok) { return }

    # 3) prove that label writes are denied without the temporary grant
    $directAttempt = Set-FixtureLabel -Path $file -LevelSpecification 'Medium'
    $denied = ($directAttempt.exitCode -ne 0) -and (($directAttempt.exitCode -eq 5) -or ($directAttempt.output -match 'denied'))
    Test-Assert -Name 'needs-grant-direct-write-denied' -Condition $denied -Detail ('exit=' + $directAttempt.exitCode + ' output=' + $directAttempt.output)
    $labelStillLow = Get-LabelInfo $file
    Test-Assert -Name 'needs-grant-label-untouched-after-denial' -Condition ($labelStillLow.ok -and $labelStillLow.level -eq 'Low') -Detail ('level=' + $labelStillLow.level)

    # 4) the engine must repair it through the temporary WRITE_OWNER grant fallback
    $dataDir = Join-Path $script:BaseDir 'data-needs-grant'
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Repair', '-Root', $dir, '-SkipDirs', 'node_modules', '-DataDir', $dataDir)
    Test-EventContract -Run $run -NamePrefix 'needs-grant'
    Test-Assert -Name 'needs-grant-exit-code' -Condition ($run.exitCode -eq 0) -Detail ('exit=' + $run.exitCode)
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        Test-Assert -Name 'needs-grant-fixed' -Condition ([int]$result.fixed -eq 1) -Detail ('fixed=' + [int]$result.fixed + ' hits=' + [int]$result.hits)
        Test-Assert -Name 'needs-grant-remaining' -Condition ([int]$result.remaining -eq 0) -Detail ('remaining=' + [int]$result.remaining)
        Test-Assert -Name 'needs-grant-failed-empty' -Condition (@($result.failed).Count -eq 0) -Detail ('failed=' + @($result.failed).Count)
        $grantCount = 0
        if ($null -ne $result.methods -and $null -ne $result.methods.PSObject.Properties['grant']) { $grantCount = [int]$result.methods.grant }
        Test-Assert -Name 'needs-grant-method' -Condition ($grantCount -gt 0) -Detail ('methods.grant=' + $grantCount)
    }
    $labelAfterRepair = Get-LabelInfo $file
    Test-Assert -Name 'needs-grant-label-medium' -Condition ($labelAfterRepair.ok -and $labelAfterRepair.level -eq 'Medium') -Detail ('level=' + $labelAfterRepair.level + ' explicit=' + $labelAfterRepair.explicit)
    $daclAfter = Get-DaclSddl $file
    Test-Assert -Name 'needs-grant-dacl-restored' -Condition ($daclAfter.ok -and ([string]$daclAfter.sddl -eq [string]$daclBefore.sddl)) -Detail ('before=' + [string]$daclBefore.sddl + ' after=' + [string]$daclAfter.sddl)
    $rescan = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $dir, '-SkipDirs', 'node_modules')
    Test-Assert -Name 'needs-grant-rescan' -Condition ($rescan.exitCode -eq 0) -Detail ('exit=' + $rescan.exitCode)
}

function Test-DataDirExclusion {
    $root = Join-Path $script:BaseDir 'datadir-root'
    New-FixtureDirectory $root
    New-FixtureFile (Join-Path $root 'visible.txt') 'low'
    $dataDir = Join-Path $root 'data'
    New-FixtureDirectory $dataDir
    New-FixtureFile (Join-Path $dataDir 'pre-existing-low.txt') 'low'
    if ($script:FullMode) {
        $setLow = Set-FixtureLabel -Path $root -LevelSpecification '(OI)(CI)Low'
        Test-Assert -Name 'datadir-exclusion-setup' -Condition ($setLow.exitCode -eq 0) -Detail $setLow.output
        if ($setLow.exitCode -ne 0) { return }
    }
    $preInfo = Get-LabelInfo (Join-Path $dataDir 'pre-existing-low.txt')
    Test-Assert -Name 'datadir-exclusion-pre-existing-low' -Condition ($preInfo.ok -and $preInfo.level -eq 'Low') -Detail ('level=' + $preInfo.level)

    $run = Invoke-Engine -EngineArguments @('-Mode', 'Repair', '-Root', $root, '-SkipDirs', 'node_modules', '-DataDir', $dataDir)
    Test-EventContract -Run $run -NamePrefix 'datadir-exclusion'
    $hits = @(Get-EventsOfType $run 'hit')
    Test-Assert -Name 'datadir-exclusion-hit-count' -Condition ($hits.Count -eq 2) -Detail ('hits=' + $hits.Count + ' expected=2 (root + visible.txt, DataDir subtree excluded)')
    $dataLower = $dataDir.ToLowerInvariant().TrimEnd('\')
    $badHits = New-Object System.Collections.ArrayList
    foreach ($hit in $hits) {
        $pathLower = ([string]$hit.path).ToLowerInvariant()
        if ($pathLower -eq $dataLower -or $pathLower.StartsWith($dataLower + '\')) { [void]$badHits.Add([string]$hit.path) }
    }
    Test-Assert -Name 'datadir-exclusion-hits' -Condition ($badHits.Count -eq 0) -Detail ('hits under DataDir: ' + (($badHits | Select-Object -First 3) -join '; '))
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        Test-Assert -Name 'datadir-exclusion-snapshot' -Condition ([System.IO.File]::Exists([string]$result.snapshotPath)) -Detail ('snapshotPath=' + [string]$result.snapshotPath)
        Test-Assert -Name 'datadir-exclusion-snapshot-dir' -Condition ([System.IO.Directory]::Exists((Join-Path $dataDir 'snapshots'))) -Detail ((Join-Path $dataDir 'snapshots'))
        $badFailures = New-Object System.Collections.ArrayList
        foreach ($entry in @($result.failed)) {
            $pathLower = ([string]$entry.path).ToLowerInvariant()
            if ($pathLower -eq $dataLower -or $pathLower.StartsWith($dataLower + '\')) { [void]$badFailures.Add([string]$entry.path) }
        }
        Test-Assert -Name 'datadir-exclusion-failed' -Condition ($badFailures.Count -eq 0) -Detail ('failed under DataDir: ' + (($badFailures | Select-Object -First 3) -join '; '))
        if ($script:FullMode) {
            Test-Assert -Name 'datadir-exclusion-repair-success' -Condition (($run.exitCode -eq 0) -and ([int]$result.remaining -eq 0)) -Detail ('exit=' + $run.exitCode + ' remaining=' + [int]$result.remaining + ' failed=' + @($result.failed).Count)
        } else {
            Test-Assert -Name 'datadir-exclusion-repair-failure' -Condition ($run.exitCode -eq 2) -Detail ('exit=' + $run.exitCode + ' failed=' + @($result.failed).Count + ' remaining=' + [int]$result.remaining)
        }
    }
}

function Test-SnapshotDocument {
    param([string]$SnapshotPath, [int]$ExpectedHitCount, [string]$Prefix)
    if (-not [System.IO.File]::Exists($SnapshotPath)) {
        Add-Fail -Name ($Prefix + '-snapshot-missing') -Detail $SnapshotPath
        return $false
    }
    try {
        $text = [System.IO.File]::ReadAllText($SnapshotPath, $script:Utf8NoBom)
        $document = $text | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Add-Fail -Name ($Prefix + '-snapshot-json') -Detail $_.Exception.Message
        return $false
    }
    $ok = $true
    if ([int]$document.hitCount -ne $ExpectedHitCount) { $ok = $false }
    $hits = @($document.hits)
    if ($hits.Count -ne $ExpectedHitCount) { $ok = $false }
    foreach ($hit in $hits) {
        if ($null -eq $hit.PSObject.Properties['path'] -or
            $null -eq $hit.PSObject.Properties['kind'] -or
            $null -eq $hit.PSObject.Properties['explicit'] -or
            $null -eq $hit.PSObject.Properties['label'] -or
            $null -eq $hit.PSObject.Properties['sddl']) { $ok = $false }
    }
    return $ok
}

function Test-ScriptParses {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $false }
    try {
        $tokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
        if ($null -ne $parseErrors) {
            if ($parseErrors.Count -gt 0) { return $false }
        }
        # Parse the text again through the current PowerShell engine. This catches
        # Windows PowerShell 5.1 syntax breaks such as a trailing comma in an
        # array literal ("$a = @(1,)" -> ParserError), which ParseFile above also
        # reports but which is worth asserting explicitly.
        $text = [System.IO.File]::ReadAllText($Path)
        [void][scriptblock]::Create($text)
        return $true
    } catch {
        return $false
    }
}

function Get-NonHitSddlSnapshot {
    param($Fixtures)
    $snapshot = @{}
    $paths = @($Fixtures.cleanFile, $Fixtures.cleanDir, $Fixtures.junctionLink, $Fixtures.junctionDir)
    foreach ($path in $paths) {
        if ($null -eq $path) { continue }
        $info = Get-LabelInfo $path
        $snapshot[([string]$path).ToLowerInvariant()] = @{ path = $path; sddl = $info.sddl; level = $info.level }
    }
    return $snapshot
}

function Test-NonHitSddlUnchanged {
    param($Before, $Fixtures, [string]$Prefix)
    $mismatches = New-Object System.Collections.ArrayList
    foreach ($key in $Before.Keys) {
        $info = Get-LabelInfo $Before[$key].path
        if ([string]$info.sddl -ne [string]$Before[$key].sddl) {
            [void]$mismatches.Add($Before[$key].path + ' before=' + [string]$Before[$key].sddl + ' after=' + [string]$info.sddl)
        }
    }
    Test-Assert -Name ($Prefix + '-non-hit-sddl-unchanged') -Condition ($mismatches.Count -eq 0) -Detail (($mismatches | Select-Object -First 3) -join '; ')
}

function Test-RepairSuccess {
    param($Fixtures, $ExpectedHits, $ScanOutcome)
    $beforeSnapshot = Get-NonHitSddlSnapshot -Fixtures $Fixtures
    $dataDir = Join-Path $script:BaseDir 'data-repair-ok'
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Repair', '-Root', $Fixtures.root, '-SkipDirs', 'node_modules', '-DataDir', $dataDir)
    Test-EventContract -Run $run -NamePrefix 'repair-ok'
    Test-Assert -Name 'repair-ok-exit-code' -Condition ($run.exitCode -eq 0) -Detail ('exit=' + $run.exitCode)
    $result = Get-ResultEvent $run
    if ($null -ne $result) {
        Test-Assert -Name 'repair-ok-fixed' -Condition ([int]$result.fixed -eq $ExpectedHits.Count) -Detail ('fixed=' + [int]$result.fixed + ' expected=' + $ExpectedHits.Count)
        Test-Assert -Name 'repair-ok-failed-empty' -Condition (@($result.failed).Count -eq 0) -Detail ('failed=' + @($result.failed).Count)
        Test-Assert -Name 'repair-ok-remaining-zero' -Condition ([int]$result.remaining -eq 0) -Detail ('remaining=' + [int]$result.remaining)
        Test-Assert -Name 'repair-ok-snapshot-exists' -Condition ([System.IO.File]::Exists([string]$result.snapshotPath)) -Detail ('snapshotPath=' + [string]$result.snapshotPath)
        Test-Assert -Name 'repair-ok-restore-exists' -Condition ([System.IO.File]::Exists([string]$result.restorePath)) -Detail ('restorePath=' + [string]$result.restorePath)
        Test-Assert -Name 'repair-ok-snapshot-document' -Condition (Test-SnapshotDocument -SnapshotPath ([string]$result.snapshotPath) -ExpectedHitCount $ScanOutcome.hits.Count -Prefix 'repair-ok') -Detail ('hits=' + $ScanOutcome.hits.Count)
        Test-Assert -Name 'repair-ok-restore-parse' -Condition (Test-ScriptParses -Path ([string]$result.restorePath)) -Detail ('restorePath=' + [string]$result.restorePath)
    }

    $rescan = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $Fixtures.root, '-SkipDirs', 'node_modules')
    Test-Assert -Name 'repair-ok-rescan-exit' -Condition ($rescan.exitCode -eq 0) -Detail ('exit=' + $rescan.exitCode)
    Test-Assert -Name 'repair-ok-rescan-zero-hits' -Condition (@(Get-EventsOfType $rescan 'hit').Count -eq 0) -Detail ('hits=' + @(Get-EventsOfType $rescan 'hit').Count)

    $labelMismatches = New-Object System.Collections.ArrayList
    foreach ($expected in $ExpectedHits) {
        $info = Get-LabelInfo $expected.path
        if (-not $info.ok -or $info.level -eq 'Low') {
            [void]$labelMismatches.Add($expected.path + ' level=' + $info.level)
        }
    }
    Test-Assert -Name 'repair-ok-labels-medium' -Condition ($labelMismatches.Count -eq 0) -Detail (($labelMismatches | Select-Object -First 5) -join '; ')
    Test-NonHitSddlUnchanged -Before $beforeSnapshot -Fixtures $Fixtures -Prefix 'repair-ok'
    return $result
}

function Test-RestoreRoundtrip {
    param($Fixtures, $ExpectedHits, $RepairResult)
    if ($null -eq $RepairResult -or [string]::IsNullOrEmpty([string]$RepairResult.restorePath)) {
        Add-Skip -Name 'restore-roundtrip' -Detail 'no restore script from repair'
        return
    }
    $restorePath = [string]$RepairResult.restorePath
    $call = Invoke-Process -Executable $script:EngineHostPath -ArgumentString ('-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-ProcessArgument $restorePath)) -OutputEncoding $script:Utf8NoBom
    Test-Assert -Name 'restore-roundtrip-exit' -Condition ($call.exitCode -eq 0) -Detail ('exit=' + $call.exitCode + ' stderr=' + $call.stderr.Trim())
    $stillMedium = New-Object System.Collections.ArrayList
    foreach ($expected in $ExpectedHits) {
        $info = Get-LabelInfo $expected.path
        if (-not $info.ok -or $info.level -ne 'Low') {
            [void]$stillMedium.Add($expected.path + ' level=' + $info.level)
        }
    }
    Test-Assert -Name 'restore-roundtrip-labels-low' -Condition ($stillMedium.Count -eq 0) -Detail (($stillMedium | Select-Object -First 5) -join '; ')
}

function Test-E1Propagation {
    $e1Root = Join-Path $script:BaseDir 'e1-propagation\root'
    New-FixtureDirectory $e1Root
    New-FixtureDirectory (Join-Path $e1Root 'child-dir')
    $childFile = Join-Path $e1Root 'child-file.txt'
    New-FixtureFile $childFile 'e1'
    $setLow = Set-FixtureLabel -Path $e1Root -LevelSpecification '(OI)(CI)Low'
    if ($setLow.exitCode -ne 0) {
        Add-Fail -Name 'e1-setup-low' -Detail $setLow.output
        return
    }
    $childFileInfo = Get-LabelInfo $childFile
    $childInherited = ($childFileInfo.ok -and $childFileInfo.level -eq 'Low' -and [bool]$childFileInfo.inherited)
    Test-Assert -Name 'e1-setup-inherited-low' -Condition $childInherited -Detail ('child level=' + $childFileInfo.level + ' inherited=' + $childFileInfo.inherited + ' sddl=' + $childFileInfo.sddl)
    if (-not $childInherited) { return }

    # parent -> Medium without /T and without touching children
    $setMedium = Set-FixtureLabel -Path $e1Root -LevelSpecification '(OI)(CI)Medium'
    if ($setMedium.exitCode -ne 0) {
        Add-Fail -Name 'e1-set-root-medium' -Detail $setMedium.output
        return
    }
    $childAfter = Get-LabelInfo $childFile
    $autoRecovered = (-not $childAfter.ok -or $childAfter.level -ne 'Low')
    Add-Info -Name 'e1-propagation-observation' -Detail ('root set (OI)(CI)Medium without /T; child auto-recovered=' + $autoRecovered + ' child level=' + $childAfter.level + ' inherited=' + $childAfter.inherited)

    $scanRun = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $e1Root, '-SkipDirs', 'node_modules')
    $hits = @(Get-EventsOfType $scanRun 'hit')
    $consistent = $false
    if ($autoRecovered) {
        $consistent = ($scanRun.exitCode -eq 0) -and ($hits.Count -eq 0)
    } else {
        $consistent = ($scanRun.exitCode -eq 2) -and ($hits.Count -gt 0)
    }
    Test-Assert -Name 'e1-engine-consistency' -Condition $consistent -Detail ('autoRecovered=' + $autoRecovered + ' exit=' + $scanRun.exitCode + ' hits=' + $hits.Count)
}

function Test-EngineParityPwsh7 {
    $pwshPath = Find-Pwsh7
    if (-not $pwshPath) {
        Add-Skip -Name 'engine-parity-pwsh7' -Detail 'pwsh 7 not found'
        return
    }
    if ($pwshPath.ToLowerInvariant() -eq $script:EngineHostPath.ToLowerInvariant()) {
        Add-Skip -Name 'engine-parity-pwsh7' -Detail 'engine host is already pwsh 7'
        return
    }
    $run = Invoke-Engine -EngineArguments @('-Mode', 'Env') -HostPath $pwshPath
    Test-Assert -Name 'engine-parity-pwsh7-exit' -Condition ($run.exitCode -eq 0) -Detail ('exit=' + $run.exitCode)
    $events = @(Get-EventsOfType $run 'env')
    Test-Assert -Name 'engine-parity-pwsh7-event' -Condition ($events.Count -eq 1) -Detail ('count=' + $events.Count)
    if ($events.Count -gt 0) {
        $altIntegrity = [string]$events[0].integrity
        Test-Assert -Name 'engine-parity-pwsh7-integrity' -Condition (-not [string]::IsNullOrEmpty($altIntegrity)) -Detail ('integrity=' + $altIntegrity)
        Test-Assert -Name 'engine-parity-pwsh7-canwrite' -Condition ([bool]$events[0].canWriteLabel -eq [bool]$script:CanWriteLabel) -Detail ('canWriteLabel=' + [bool]$events[0].canWriteLabel)
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host '============================================================'
Write-Host ' dsh-file-integrity-check - engine fixture tests'
Write-Host '============================================================'
Write-Host ('Run id      : ' + $script:RunId)
Write-Host ('Fixture dir : ' + $script:BaseDir)
Write-Host ('Engine      : ' + $script:EnginePath)
$script:EngineHostPath = Resolve-EngineHostPath -Requested $EngineHost
Write-Host ('Engine host : ' + $script:EngineHostPath)
Write-Host ('Test host PS: ' + $PSVersionTable.PSVersion.ToString())
$script:IcaclsPath = Get-IcaclsExecutable -Candidate 'icacls.exe'
Write-Host ('icacls      : ' + $script:IcaclsPath)
Write-Host ''

try {
    if (-not [System.IO.File]::Exists($script:EnginePath)) {
        throw ('Engine script not found: ' + $script:EnginePath)
    }

    New-FixtureDirectory $script:BaseDir

    # ---- capability probe -------------------------------------------------
    $probeDirectory = Join-Path $script:BaseDir 'capability-probe'
    New-FixtureDirectory $probeDirectory
    $probeFile = Join-Path $probeDirectory 'probe.txt'
    New-FixtureFile $probeFile 'probe'
    $probe = Set-FixtureLabel -Path $probeFile -LevelSpecification 'Medium'
    $script:CapabilityProbeOutput = $probe.output
    $script:CanWriteLabel = ($probe.exitCode -eq 0)
    $script:FullMode = [bool]$script:CanWriteLabel
    $probeInfo = Get-LabelInfo $probeFile
    Add-Info -Name 'capability-probe' -Detail ('label writes available=' + $script:FullMode + ' probe exit=' + $probe.exitCode + ' probe label=' + $probeInfo.level)
    if ($script:FullMode) {
        Add-Info -Name 'test-mode' -Detail 'FULL fixture suite (label writes available: clean / explicit / repair-success / E1 are executed)'
    } else {
        Add-Info -Name 'test-mode' -Detail 'SANDBOX fixture suite (label writes denied: clean / explicit / repair-success / E1 are SKIPped)'
    }
    Remove-Tree -Path $probeDirectory

    # ---- fixtures ---------------------------------------------------------
    if ($script:FullMode) {
        $fixtures = Initialize-FullFixtures
        if ($fixtures.labelFailures.Count -gt 0) {
            Add-Fail -Name 'fixture-label-setup' -Detail (($fixtures.labelFailures | Select-Object -First 3) -join '; ')
        } else {
            Add-Pass -Name 'fixture-label-setup' -Detail 'all integrity labels applied'
        }
        Test-AssertLabel -Name 'setup-low-inherited-root-explicit' -Path $fixtures.lowInherited -ExpectedLevel 'Low' -ExpectedExplicit $true
        Test-AssertLabel -Name 'setup-low-inherited-child-inherited' -Path (Join-Path $fixtures.lowInherited 'child-dir') -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-deep-file-inherited' -Path $fixtures.deepFile -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-explicit-file' -Path $fixtures.explicitFile -ExpectedLevel 'Low' -ExpectedExplicit $true
        Test-AssertLabel -Name 'setup-explicit-dir' -Path $fixtures.explicitDir -ExpectedLevel 'Low' -ExpectedExplicit $true
        Test-AssertLabel -Name 'setup-explicit-dir-child-inherited' -Path $fixtures.explicitDirChild -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-localized-dir' -Path $fixtures.localizedDir -ExpectedLevel 'Low' -ExpectedExplicit $true
        Test-AssertLabel -Name 'setup-localized-file-inherited' -Path $fixtures.localizedFile -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertNotLow -Name 'setup-clean-file-not-low' -Path $fixtures.cleanFile
        Test-AssertNotLow -Name 'setup-junction-link-not-low' -Path $fixtures.junctionLink
        $expectedHits = Get-FullExpectedHits -Fixtures $fixtures
    } else {
        $fixtures = Initialize-SandboxFixtures
        Add-Pass -Name 'fixture-label-setup' -Detail 'sandbox: all created objects inherit Low'
        Test-AssertLabel -Name 'setup-root-inherited-low' -Path $fixtures.root -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-junction-link-inherited-low' -Path $fixtures.junctionLink -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-node-modules-file-low' -Path $fixtures.nodeModulesFile -ExpectedLevel 'Low' -ExpectedExplicit $false
        Test-AssertLabel -Name 'setup-target-file-low' -Path $fixtures.targetFile -ExpectedLevel 'Low' -ExpectedExplicit $false
        $expectedHits = Get-SandboxExpectedHits -Fixtures $fixtures
    }

    # ---- Env --------------------------------------------------------------
    $envEvent = Test-EnvMode

    # ---- Scan -------------------------------------------------------------
    $prefix = 'scan'
    $scanOutcome = Test-ScanSuite -Fixtures $fixtures -ExpectedHits $expectedHits -Prefix $prefix
    Test-JunctionNoFollow -ScanOutcome $scanOutcome -Fixtures $fixtures -Prefix $prefix
    Test-SkipDirs -ScanOutcome $scanOutcome -Fixtures $fixtures -Prefix $prefix
    Test-LongPath -ScanOutcome $scanOutcome -Fixtures $fixtures -Prefix $prefix

    # ---- localized (Chinese/space) path as -Root --------------------------
    Test-LocalizedRoot -Fixtures $fixtures -Prefix $prefix

    # ---- fatal handling ---------------------------------------------------
    Test-FatalMissingRoot

    # ---- clean fixture (full mode only) -----------------------------------
    if ($script:FullMode) {
        $cleanRun = Invoke-Engine -EngineArguments @('-Mode', 'Scan', '-Root', $fixtures.cleanDir, '-SkipDirs', 'node_modules')
        Test-EventContract -Run $cleanRun -NamePrefix 'clean'
        $cleanHits = @(Get-EventsOfType $cleanRun 'hit')
        $cleanResult = Get-ResultEvent $cleanRun
        $cleanOk = ($cleanRun.exitCode -eq 0) -and ($cleanHits.Count -eq 0)
        if ($null -ne $cleanResult) { $cleanOk = $cleanOk -and ([string]$cleanResult.rootLabel -ne 'Low') }
        Test-Assert -Name 'clean-zero-hits' -Condition $cleanOk -Detail ('exit=' + $cleanRun.exitCode + ' hits=' + $cleanHits.Count)
    } else {
        Add-Skip -Name 'clean-zero-hits' -Detail 'cannot create a Medium (clean) fixture inside the sandbox; covered by test/run-fixtures.ps1 full mode'
        Test-ReadOnlyCleanScan
        Add-Skip -Name 'low-explicit-file-fixture' -Detail 'cannot write an explicit Low label inside the sandbox'
        Add-Skip -Name 'low-dir-explicit-fixture' -Detail 'cannot write an explicit Low label inside the sandbox'
    }

    # ---- Repair failure path ---------------------------------------------
    if ($script:FullMode) {
        Test-PinvokeFallback
    } else {
        Test-RepairFailure -Fixtures $fixtures
    }

    # ---- Repair success path + restore round-trip (full mode only) -------
    if ($script:FullMode) {
        $repairResult = Test-RepairSuccess -Fixtures $fixtures -ExpectedHits $expectedHits -ScanOutcome $scanOutcome
        Test-RestoreRoundtrip -Fixtures $fixtures -ExpectedHits $expectedHits -RepairResult $repairResult
        Test-E1Propagation
        Test-RepairNeedsGrant
        Add-Skip -Name 'repair-failure-path' -Detail 'failure path needs label writes to be denied; covered by the sandbox-mode run of this script'
    } else {
        Add-Skip -Name 'repair-success' -Detail 'requires label writes (sandbox denies icacls /setintegritylevel)'
        Add-Skip -Name 'restore-roundtrip' -Detail 'requires label writes'
        Add-Skip -Name 'e1-propagation-experiment' -Detail 'requires label writes (see Lead host-side E1 result)'
        Add-Skip -Name 'repair-needs-grant' -Detail 'requires label writes + DACL manipulation (sandbox denies /setintegritylevel)'
    }

    # ---- DataDir inside -Root must be excluded from traversal -------------
    Test-DataDirExclusion

    # ---- PS7 parity -------------------------------------------------------
    Test-EngineParityPwsh7
} catch {
    $failureDetail = $_.Exception.Message
    if ($_.ScriptStackTrace) { $failureDetail = $failureDetail + ' @ ' + ($_.ScriptStackTrace -replace "`r?`n", ' | ') }
    Add-Fail -Name 'unexpected-error' -Detail $failureDetail
} finally {
    if ($script:KeepFixtures) {
        Add-Info -Name 'cleanup' -Detail ('fixture directory kept: ' + $script:BaseDir)
    } else {
        $qualified = $script:BaseDir.ToLowerInvariant()
        $expectedRoot = $script:TestTempRoot.ToLowerInvariant()
        if ($qualified.StartsWith($expectedRoot)) {
            Remove-Tree -Path $script:BaseDir
            if (Test-Path -LiteralPath $script:BaseDir) {
                Add-Fail -Name 'cleanup' -Detail ('fixture directory still present: ' + $script:BaseDir)
            } else {
                Add-Pass -Name 'cleanup' -Detail 'fixture directory removed'
            }
        } else {
            Add-Fail -Name 'cleanup' -Detail ('refusing to remove unexpected path: ' + $script:BaseDir)
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$passCount = 0
$failCount = 0
$skipCount = 0
$infoCount = 0
foreach ($entry in $script:Results) {
    switch ($entry.status) {
        'PASS' { $passCount = $passCount + 1 }
        'FAIL' { $failCount = $failCount + 1 }
        'SKIP' { $skipCount = $skipCount + 1 }
        'INFO' { $infoCount = $infoCount + 1 }
    }
}

Write-Host ''
Write-Host '============================================================'
Write-Host ('Summary: PASS=' + $passCount + ' FAIL=' + $failCount + ' SKIP=' + $skipCount + ' INFO=' + $infoCount)
Write-Host ('Test mode: ' + $(if ($script:FullMode) { 'FULL (label writes available)' } else { 'SANDBOX (label writes denied)' }))
if ($failCount -gt 0) {
    Write-Host 'Failed cases:'
    foreach ($entry in $script:Results) {
        if ($entry.status -eq 'FAIL') { Write-Host ('  - ' + $entry.name + ' :: ' + $entry.detail) }
    }
}
if ($script:KeepFixtures) {
    Write-Host ('Fixture directory kept: ' + $script:BaseDir)
}
Write-Host '============================================================'

if ($failCount -gt 0) { exit 1 }
exit 0
