#Requires -Version 5.0
<#
.SYNOPSIS
  dsh-file-integrity-check engine: detect and repair Low integrity labels on files.

.DESCRIPTION
  Three modes:
    Env    - report current user / integrity level / icacls availability / label-write capability.
    Scan   - walk -Root, read the mandatory-integrity label of every file and directory,
             stream a "hit" line for every object whose label is Low. Reparse points
             (junctions / symlinks) are never followed. -SkipDirs entries are skipped
             entirely (neither reported nor traversed). Unreadable objects produce an
             "error" line and do not abort the scan.
    Repair - scan first (streaming hit lines), snapshot every hit into
             <DataDir>\snapshots\snapshot-*.json plus a restore-*.ps1 script, then repair:
               1. explicit-Low directories (shallowest first), icacls "(OI)(CI)Medium"
               2. explicit-Low files, icacls "Medium"
               3. rescan; any object still Low is repaired individually as a fallback
             The repair does not assume that inherited-Low children recover when their
             parent is repaired: the rescan step repairs every remaining object.
             When a label write is denied because the object DACL does not grant
             WRITE_OWNER (typical for objects created by a sandboxed/AppContainer
             process), the engine grants WRITE_OWNER to the current user temporarily,
             retries the label write, removes the grant again and verifies that the
             DACL is restored byte-for-byte. This fallback only runs when the current
             user owns the object; otherwise the object is reported as failed with
             guidance. Non-hit objects are never modified. A final verification pass
             over the original hit set produces the "failed" / "remaining" result fields.
             The restore-*.ps1 script restores EVERY snapshot hit explicitly as Low
             (inherited entries become explicit Low) and uses the same temporary-grant
             fallback when the DACL denies the label write.

  Output is UTF-8 (no BOM) JSON Lines written to stdout; diagnostics must never be
  written to stdout (they go to stderr or are dropped). Line types:
    {"type":"env",...}
    {"type":"progress","phase":"enumerate|repair|verify","scanned":n,"total":n|null,"hits":n}
    {"type":"hit","path","kind":"file"|"dir","explicit":bool,"label":"Low",...}
    {"type":"error","path","message"}                       scan / read problems
    {"type":"error","path","message","phase":"repair","output"}  repair attempt failures
    {"type":"result","mode":"scan"|"repair",...}
    {"type":"fatal","code","message"}

  Exit codes:
    0 - success (Scan: no Low hits found; Repair: nothing remaining/failed; Env: ok)
    2 - Scan found Low objects / Repair left Low objects or failures
    3 - fatal error (bad arguments, root missing, snapshot write failure, unexpected exception)

  Suppressed / non-ASCII / space / >260 char paths are supported; internal Win32 calls use
  the \\?\ prefix and icacls is used with the plain path (the \\?\ form only when needed).
  When icacls cannot change a label (e.g. it rejects a very long path) the engine falls back
  to SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION) and reports the method in the result.

.PARAMETER Mode
  Env, Scan or Repair. Default: Scan.

.PARAMETER Root
  Directory (or single file) to scan / repair. Required for Scan and Repair.

.PARAMETER SkipDirs
  Directory names skipped entirely during traversal. Default: node_modules, .git.

.PARAMETER IcaclsPath
  icacls executable (test seam). Default: icacls.exe resolved from PATH/System32.

.PARAMETER DataDir
  Base directory for Repair snapshots. Default: <temp>\dsh-file-integrity-check.
  Snapshots and restore scripts are written to <DataDir>\snapshots\.

.PARAMETER Json
  Accepted for Host compatibility; output is always JSON Lines.

.NOTES
  Windows PowerShell 5.1 compatible (no PS7-only syntax, no ternary, no ??).
  engineVersion 0.1.0
#>
[CmdletBinding()]
param(
    [ValidateSet('Env', 'Scan', 'Repair')]
    [string]$Mode = 'Scan',

    [string]$Root,

    [string[]]$SkipDirs = @('node_modules', '.git'),

    [string]$IcaclsPath = 'icacls.exe',

    [string]$DataDir,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$script:EngineVersion = '0.1.0'
$script:MaxScannedItems = 1000000
$script:MaxErrorsInResult = 1000
$script:CurrentUserSidCache = $null

# ---------------------------------------------------------------------------
# UTF-8 (no BOM) output. JSON Lines are written through our own StreamWriter so
# that native PowerShell formatting / host encoding never leaks into stdout.
# ---------------------------------------------------------------------------
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
try { $OutputEncoding = $script:Utf8NoBom } catch { }
$script:Out = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $script:Utf8NoBom)
$script:Out.AutoFlush = $true

# OEM encoding is what console tools such as icacls emit when stdout is redirected.
$script:ToolOutputEncoding = $null
try {
    $oemCodePage = [int][System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
    $script:ToolOutputEncoding = [System.Text.Encoding]::GetEncoding($oemCodePage)
} catch {
    $script:ToolOutputEncoding = [System.Text.Encoding]::Default
}

# ---------------------------------------------------------------------------
# Native helper (GetNamedSecurityInfoW / SetNamedSecurityInfoW / token IL).
# Compiled into a private type; Add-Type diagnostics are dropped from stdout.
# ---------------------------------------------------------------------------
$script:NativeTypeCode = @'
using System;
using System.Runtime.InteropServices;

namespace DshIntegrity
{
    public static class Native
    {
        public const int SeFileObject = 1;
        public const uint LabelSecurityInformation = 0x00000010;
        public const uint SddlRevision1 = 1;
        public const int TokenIntegrityLevel = 18;

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
        private static extern uint SetNamedSecurityInfoW(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            IntPtr psidOwner,
            IntPtr psidGroup,
            IntPtr pDacl,
            IntPtr pSacl);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr pSecurityDescriptor,
            uint SDRevision,
            uint SecurityInformation,
            out IntPtr StringSecurityDescriptor,
            out uint StringSecurityDescriptorLen);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string StringSecurityDescriptor,
            uint StringSDRevision,
            out IntPtr SecurityDescriptor,
            out uint SecurityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetSecurityDescriptorSacl(
            IntPtr pSecurityDescriptor,
            out bool lpbSaclPresent,
            out IntPtr pSacl,
            out bool lpbSaclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(
            IntPtr ProcessHandle,
            uint DesiredAccess,
            out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr TokenHandle,
            int TokenInformationClass,
            IntPtr TokenInformation,
            int TokenInformationLength,
            out int ReturnLength);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("advapi32.dll", EntryPoint = "GetNamedSecurityInfoW", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetNamedSecurityInfoWithOwnerW(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            out IntPtr ppsidOwner,
            IntPtr ppsidGroup,
            IntPtr ppDacl,
            IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool ConvertSidToStringSidW(IntPtr Sid, out IntPtr StringSid);

        public static string GetDaclSddl(string path, out int errorCode)
        {
            return GetSecurityDescriptorText(path, 0x00000004, out errorCode);
        }

        private static string GetSecurityDescriptorText(string path, uint securityInformation, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            uint result = GetNamedSecurityInfoW(
                path,
                SeFileObject,
                securityInformation,
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
                        SddlRevision1,
                        securityInformation,
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

        public static string GetOwnerSid(string path, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            IntPtr ownerSid;
            uint result = GetNamedSecurityInfoWithOwnerW(
                path,
                SeFileObject,
                0x00000001, // OWNER_SECURITY_INFORMATION
                out ownerSid,
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
                if (ownerSid == IntPtr.Zero)
                {
                    errorCode = 87; // ERROR_INVALID_PARAMETER
                    return null;
                }
                IntPtr text;
                if (!ConvertSidToStringSidW(ownerSid, out text))
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

        public static string GetLabelSddl(string path, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            uint result = GetNamedSecurityInfoW(
                path,
                SeFileObject,
                LabelSecurityInformation,
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
                        SddlRevision1,
                        LabelSecurityInformation,
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

        public static int SetLabel(string path, string sddl)
        {
            IntPtr securityDescriptor;
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl,
                    SddlRevision1,
                    out securityDescriptor,
                    out size))
            {
                return Marshal.GetLastWin32Error();
            }
            try
            {
                // SetNamedSecurityInfoW expects a PACL for pSacl - passing the whole
                // security descriptor (as the old code did) corrupts/removes the label.
                bool saclPresent;
                IntPtr sacl;
                bool saclDefaulted;
                if (!GetSecurityDescriptorSacl(securityDescriptor, out saclPresent, out sacl, out saclDefaulted))
                {
                    return Marshal.GetLastWin32Error();
                }
                if (!saclPresent || sacl == IntPtr.Zero)
                {
                    return 87; // ERROR_INVALID_PARAMETER
                }
                uint result = SetNamedSecurityInfoW(
                    path,
                    SeFileObject,
                    LabelSecurityInformation,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    sacl);
                if (result != 0)
                {
                    return unchecked((int)result);
                }
                return 0;
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
        }

        public static string GetTokenIntegritySid()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token))
            {
                return null;
            }
            try
            {
                int length = 0;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out length);
                if (length <= 0)
                {
                    return null;
                }
                IntPtr buffer = Marshal.AllocHGlobal(length);
                try
                {
                    int returned = 0;
                    if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, length, out returned))
                    {
                        return null;
                    }
                    IntPtr sid = Marshal.ReadIntPtr(buffer);
                    if (sid == IntPtr.Zero)
                    {
                        return null;
                    }
                    int rid = Marshal.ReadInt32(sid, 8);
                    return "S-1-16-" + rid.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'DshIntegrity.Native').Type) {
    Add-Type -TypeDefinition $script:NativeTypeCode -Language CSharp -ErrorAction Stop | Out-Null
}

# ---------------------------------------------------------------------------
# Tiny JSON writer (keeps field order and UTF-8 output deterministic).
# ---------------------------------------------------------------------------
function ConvertTo-JsonString {
    param([string]$Value)
    if ($null -eq $Value) { return 'null' }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $chars = $Value.ToCharArray()
    foreach ($ch in $chars) {
        $code = [int]$ch
        if ($code -eq 34) { [void]$builder.Append('\"') }
        elseif ($code -eq 92) { [void]$builder.Append('\\') }
        elseif ($code -eq 8) { [void]$builder.Append('\b') }
        elseif ($code -eq 9) { [void]$builder.Append('\t') }
        elseif ($code -eq 10) { [void]$builder.Append('\n') }
        elseif ($code -eq 12) { [void]$builder.Append('\f') }
        elseif ($code -eq 13) { [void]$builder.Append('\r') }
        elseif ($code -lt 32) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-JsonValue {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [string]) { return (ConvertTo-JsonString $Value) }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [single] -or
        $Value -is [decimal] -or $Value -is [int16] -or $Value -is [byte] -or $Value -is [uint32] -or $Value -is [uint64]) {
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = New-Object System.Collections.ArrayList
        foreach ($key in $Value.Keys) {
            $keyText = ConvertTo-JsonString ([string]$key)
            $valueText = ConvertTo-JsonValue $Value[$key]
            [void]$parts.Add($keyText + ':' + $valueText)
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = New-Object System.Collections.ArrayList
        foreach ($item in $Value) {
            [void]$parts.Add((ConvertTo-JsonValue $item))
        }
        return '[' + ($parts -join ',') + ']'
    }
    return (ConvertTo-JsonString ([string]$Value))
}

function Write-Event {
    param([System.Collections.IDictionary]$Fields)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('{')
    $first = $true
    foreach ($key in $Fields.Keys) {
        if ($first) { $first = $false } else { [void]$builder.Append(',') }
        [void]$builder.Append((ConvertTo-JsonString ([string]$key)))
        [void]$builder.Append(':')
        [void]$builder.Append((ConvertTo-JsonValue $Fields[$key]))
    }
    [void]$builder.Append('}')
    $script:Out.WriteLine($builder.ToString())
}

function Write-Fatal {
    param([string]$Code, [string]$Message)
    $text = ''
    if ($null -ne $Message) { $text = [string]$Message }
    $text = $text -replace "`r?`n", ' '
    Write-Event -Fields ([ordered]@{ type = 'fatal'; code = $Code; message = $text })
}

function Write-ProgressEvent {
    param([string]$Phase, [int]$Scanned, $Total, [int]$Hits)
    Write-Event -Fields ([ordered]@{ type = 'progress'; phase = $Phase; scanned = $Scanned; total = $Total; hits = $Hits })
}

function Write-HitEvent {
    param($Hit)
    Write-Event -Fields ([ordered]@{
            type      = 'hit'
            path      = $Hit.path
            kind      = $Hit.kind
            explicit  = [bool]$Hit.explicit
            label     = 'Low'
            inherited = [bool]$Hit.inherited
            sddl      = $Hit.sddl
        })
}

function Get-Win32Message {
    param([int]$Code)
    try {
        $exception = New-Object System.ComponentModel.Win32Exception($Code)
        return $exception.Message
    } catch {
        return ('Win32 error ' + $Code)
    }
}

# ---------------------------------------------------------------------------
# Path helpers (\\?\ prefix handling; 5.1-safe, no PathTooLongException paths).
# ---------------------------------------------------------------------------
function Resolve-RootPath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return '' }
    $value = $Path
    if ($value.StartsWith('\\?\UNC\')) { return ('\\' + $value.Substring(8)) }
    if ($value.StartsWith('\\?\')) { return $value.Substring(4) }
    try { $value = [System.IO.Path]::GetFullPath($value) } catch { }
    if ($value.Length -gt 3 -and $value.EndsWith('\') -and -not $value.EndsWith(':\')) {
        $value = $value.Substring(0, $value.Length - 1)
    }
    return $value
}

function ConvertTo-NormalPath {
    param([string]$Path)
    if ($null -eq $Path) { return $Path }
    if ($Path.StartsWith('\\?\UNC\')) { return ('\\' + $Path.Substring(8)) }
    if ($Path.StartsWith('\\?\')) { return $Path.Substring(4) }
    return $Path
}

function Get-Win32Path {
    param([string]$NormalPath)
    if ($null -eq $NormalPath) { return $NormalPath }
    if ($NormalPath.StartsWith('\\?\')) { return $NormalPath }
    if ($NormalPath -match '^[A-Za-z]:\\$') { return $NormalPath }
    if ($NormalPath.StartsWith('\\')) { return ('\\?\UNC\' + $NormalPath.Substring(2)) }
    return ('\\?\' + $NormalPath)
}

function Get-PathLeaf {
    param([string]$NormalPath)
    if ([string]::IsNullOrEmpty($NormalPath)) { return '' }
    try { return [System.IO.Path]::GetFileName($NormalPath) } catch { return '' }
}

function Get-PathDepth {
    param([string]$NormalPath)
    if ([string]::IsNullOrEmpty($NormalPath)) { return 0 }
    return (($NormalPath -split '\\').Length)
}

function Write-TextFileNoBom {
    param([string]$Path, [string]$Text)
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if ($directory -and -not [System.IO.Directory]::Exists($directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Write-TextFileUtf8Bom {
    param([string]$Path, [string]$Text)
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if ($directory -and -not [System.IO.Directory]::Exists($directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    # The restore script may embed non-ASCII paths and is executed by Windows
    # PowerShell 5.1, which reads BOM-less scripts as ANSI; a BOM keeps it safe.
    $encoding = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

# ---------------------------------------------------------------------------
# Integrity label parsing.
# ---------------------------------------------------------------------------
function ConvertFrom-IntegrityRid {
    param([int]$Rid)
    switch ($Rid) {
        0 { return 'Untrusted' }
        4096 { return 'Low' }
        8192 { return 'Medium' }
        12288 { return 'High' }
        16384 { return 'System' }
        20480 { return 'Protected' }
        default { return ('S-1-16-' + $Rid) }
    }
}

function ConvertFrom-IntegritySid {
    param([string]$Sid)
    if ($null -eq $Sid) { return 'None' }
    switch ($Sid) {
        'LW' { return 'Low' }
        'ME' { return 'Medium' }
        'HI' { return 'High' }
        'SI' { return 'System' }
        'UNT' { return 'Untrusted' }
        default {
            $m = [regex]::Match($Sid, '^S-1-16-(\d+)$')
            if ($m.Success) {
                return (ConvertFrom-IntegrityRid ([int]$m.Groups[1].Value))
            }
            return $Sid
        }
    }
}

function ConvertTo-SddlLevelAbbreviation {
    param([string]$Level)
    switch ($Level) {
        'Low' { return 'LW' }
        'Medium' { return 'ME' }
        'High' { return 'HI' }
        'System' { return 'SI' }
        default { return $Level }
    }
}

function ConvertFrom-LabelSddl {
    param([string]$Sddl)
    $result = @{
        ok        = $true
        sddl      = $Sddl
        level     = 'None'
        explicit  = $false
        inherited = $false
        hasLabel  = $false
        sid       = ''
        aceFlags  = ''
    }
    if ([string]::IsNullOrEmpty($Sddl)) { return $result }

    $aceMatches = [regex]::Matches($Sddl, '\(ML;([^;]*);([^;]*);[^;]*;[^;]*;([^)]*)\)')
    if ($aceMatches.Count -eq 0) { return $result }

    $explicitAce = $null
    $inheritedAce = $null
    foreach ($ace in $aceMatches) {
        $flags = $ace.Groups[1].Value
        $isInherited = $flags -match 'ID'
        if ($isInherited) {
            if ($null -eq $inheritedAce) { $inheritedAce = $ace }
        } else {
            if ($null -eq $explicitAce) { $explicitAce = $ace }
        }
    }

    $chosen = $explicitAce
    if ($null -eq $chosen) { $chosen = $inheritedAce }
    if ($null -eq $chosen) { return $result }

    $chosenFlags = $chosen.Groups[1].Value
    $chosenSid = $chosen.Groups[3].Value
    $result.hasLabel = $true
    $result.aceFlags = $chosenFlags
    $result.sid = $chosenSid
    $result.inherited = ($chosenFlags -match 'ID')
    $result.explicit = -not $result.inherited
    $result.level = (ConvertFrom-IntegritySid $chosenSid)
    return $result
}

function Get-IntegrityLabelInfo {
    param([string]$Win32Path)
    $errorCode = 0
    $sddl = [DshIntegrity.Native]::GetLabelSddl($Win32Path, [ref]$errorCode)
    if ($errorCode -ne 0) {
        return @{
            ok        = $false
            errorCode = $errorCode
            message   = (Get-Win32Message $errorCode)
            level     = 'Unknown'
            explicit  = $false
            inherited = $false
            hasLabel  = $false
            sddl      = $null
            sid       = ''
            aceFlags  = ''
        }
    }
    return (ConvertFrom-LabelSddl -Sddl $sddl)
}

# ---------------------------------------------------------------------------
# Owner / DACL helpers (needed for the temporary-WRITE_OWNER repair fallback).
# ---------------------------------------------------------------------------
function Get-CurrentUserSid {
    if ($null -ne $script:CurrentUserSidCache) { return $script:CurrentUserSidCache }
    $sid = ''
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -ne $identity -and $null -ne $identity.User) { $sid = [string]$identity.User.Value }
    } catch { $sid = '' }
    $script:CurrentUserSidCache = $sid
    return $sid
}

function Get-IntegrityObjectDaclSddl {
    param([string]$Win32Path)
    $errorCode = 0
    $sddl = [DshIntegrity.Native]::GetDaclSddl($Win32Path, [ref]$errorCode)
    if ($errorCode -ne 0) {
        return @{ ok = $false; sddl = $null; errorCode = $errorCode; message = (Get-Win32Message $errorCode) }
    }
    return @{ ok = $true; sddl = $sddl; errorCode = 0; message = '' }
}

function Get-IntegrityObjectOwnerSid {
    param([string]$Win32Path)
    $errorCode = 0
    $sid = [DshIntegrity.Native]::GetOwnerSid($Win32Path, [ref]$errorCode)
    if ($errorCode -ne 0) {
        return @{ ok = $false; sid = $null; errorCode = $errorCode; message = (Get-Win32Message $errorCode) }
    }
    return @{ ok = $true; sid = $sid; errorCode = 0; message = '' }
}

function Get-IcaclsToolPath {
    param([string]$NormalPath, [string]$Win32Path)
    if ($NormalPath.Length -ge 255 -or $NormalPath.StartsWith('\\')) { return $Win32Path }
    return $NormalPath
}

# ---------------------------------------------------------------------------
# Env helpers.
# ---------------------------------------------------------------------------
function ConvertFrom-IntegrityText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return 'Unknown' }
    $m = [regex]::Match($Text, 'S-1-16-(\d+)')
    if ($m.Success) { return (ConvertFrom-IntegrityRid ([int]$m.Groups[1].Value)) }
    return 'Unknown'
}

function Get-CurrentIntegrityName {
    try {
        $whoamiPath = Join-Path $env:SystemRoot 'System32\whoami.exe'
        $lines = @()
        if ([System.IO.File]::Exists($whoamiPath)) {
            $lines = @(& $whoamiPath /groups 2>$null)
        } else {
            $lines = @(& whoami.exe /groups 2>$null)
        }
        foreach ($line in $lines) {
            if ([string]$line -match 'S-1-16-(\d+)') {
                return (ConvertFrom-IntegrityRid ([int]$Matches[1]))
            }
        }
    } catch { }

    try {
        $sid = [DshIntegrity.Native]::GetTokenIntegritySid()
        if ($sid) {
            $m = [regex]::Match($sid, '^S-1-16-(\d+)$')
            if ($m.Success) { return (ConvertFrom-IntegrityRid ([int]$m.Groups[1].Value)) }
        }
    } catch { }
    return 'Unknown'
}

function Resolve-IcaclsExecutable {
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
    try {
        $fallback = Join-Path $env:SystemRoot 'System32\icacls.exe'
        if ([System.IO.File]::Exists($fallback)) { return $fallback }
    } catch { }
    return $Candidate
}

# ---------------------------------------------------------------------------
# icacls / label mutation helpers.
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

function Invoke-IcaclsProcess {
    param([string]$Executable, [string]$ArgumentString)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $ArgumentString
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    if ($null -ne $script:ToolOutputEncoding) {
        try { $startInfo.StandardOutputEncoding = $script:ToolOutputEncoding } catch { }
        try { $startInfo.StandardErrorEncoding = $script:ToolOutputEncoding } catch { }
    }
    $process = $null
    $stdout = ''
    $stderr = ''
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } catch {
        return @{ exitCode = -1; output = $_.Exception.Message; stdout = ''; stderr = '' }
    } finally {
        if ($null -ne $process) { try { $process.Dispose() } catch { } }
    }
    $combined = (($stdout + "`r`n" + $stderr).Trim())
    return @{ exitCode = $exitCode; output = $combined; stdout = $stdout.Trim(); stderr = $stderr.Trim() }
}

function Test-CanWriteLabel {
    param([string]$IcaclsExecutable)
    $probeDirectory = $null
    $probeFile = $null
    $result = $false
    try {
        $tempRoot = [System.IO.Path]::GetTempPath()
        if ([string]::IsNullOrEmpty($tempRoot)) { return $false }
        $name = 'dsh-integrity-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $probeDirectory = Join-Path $tempRoot $name
        [System.IO.Directory]::CreateDirectory($probeDirectory) | Out-Null
        $probeFile = Join-Path $probeDirectory 'probe.txt'
        [System.IO.File]::WriteAllText($probeFile, 'probe')
        $arguments = (Quote-ProcessArgument $probeFile) + ' /setintegritylevel Medium'
        $call = Invoke-IcaclsProcess -Executable $IcaclsExecutable -ArgumentString $arguments
        if ($call.exitCode -eq 0) { $result = $true }
    } catch {
        $result = $false
    } finally {
        if ($probeFile) {
            try {
                [System.IO.File]::SetAttributes($probeFile, [System.IO.FileAttributes]::Normal)
                [System.IO.File]::Delete($probeFile)
            } catch { }
        }
        if ($probeDirectory) { try { [System.IO.Directory]::Delete($probeDirectory, $false) } catch { } }
    }
    return $result
}

function Set-IntegrityLevelOnPath {
    param(
        [string]$NormalPath,
        [string]$Win32Path,
        [string]$Kind,
        [string]$TargetLevel
    )
    $levelSpecification = $TargetLevel
    if ($Kind -eq 'dir') { $levelSpecification = '(OI)(CI)' + $TargetLevel }

    $toolPath = Get-IcaclsToolPath -NormalPath $NormalPath -Win32Path $Win32Path

    $arguments = (Quote-ProcessArgument $toolPath) + ' /setintegritylevel ' + (Quote-ProcessArgument $levelSpecification)
    $call = Invoke-IcaclsProcess -Executable $script:IcaclsExecutable -ArgumentString $arguments
    if ($call.exitCode -eq 0) {
        return @{ ok = $true; method = 'icacls'; output = $call.output; message = ''; icaclsExitCode = 0 }
    }

    # icacls failed: try the API directly (needed for paths icacls rejects, harmless otherwise).
    $nativeResult = -1
    $fallbackMessage = ''
    try {
        $sddlLevel = ConvertTo-SddlLevelAbbreviation $TargetLevel
        if ($Kind -eq 'dir') {
            $sddl = 'S:(ML;OICI;NW;;;' + $sddlLevel + ')'
        } else {
            $sddl = 'S:(ML;;NW;;;' + $sddlLevel + ')'
        }
        $nativeResult = [DshIntegrity.Native]::SetLabel($Win32Path, $sddl)
        if ($nativeResult -eq 0) {
            return @{
                ok            = $true
                method        = 'pinvoke'
                output        = $call.output
                message       = 'icacls failed; P/Invoke SetNamedSecurityInfoW succeeded'
                icaclsExitCode = $call.exitCode
            }
        }
        $fallbackMessage = 'P/Invoke SetNamedSecurityInfoW failed: Win32 ' + $nativeResult + ' (' + (Get-Win32Message $nativeResult) + ')'
    } catch {
        $fallbackMessage = 'P/Invoke fallback threw: ' + $_.Exception.Message
    }

    # Both direct attempts were denied. When the current user owns the object but its
    # DACL does not grant WRITE_OWNER (typical for objects created by a sandboxed /
    # AppContainer process), grant WRITE_OWNER temporarily, set the label, then remove
    # the grant again and verify that the DACL is byte-for-byte restored.
    $accessDenied = (($call.exitCode -eq 5) -or ($nativeResult -eq 5))
    if ($accessDenied) {
        return (Set-IntegrityLevelWithOwnerGrant -NormalPath $NormalPath -Win32Path $Win32Path -Kind $Kind -TargetLevel $TargetLevel -OriginalOutput $call.output)
    }

    $message = 'icacls exit ' + $call.exitCode + '; ' + $fallbackMessage
    return @{
        ok            = $false
        method        = 'icacls+pinvoke'
        output        = $call.output
        message       = $message
        icaclsExitCode = $call.exitCode
    }
}

function Set-IntegrityLevelWithOwnerGrant {
    param(
        [string]$NormalPath,
        [string]$Win32Path,
        [string]$Kind,
        [string]$TargetLevel,
        [string]$OriginalOutput
    )
    $baseMessage = 'access denied (icacls/Win32 5)'
    $guidance = 'guidance: run the repair as the object owner or with administrator rights'
    $aclBefore = Get-IntegrityObjectDaclSddl -Win32Path $Win32Path
    if (-not $aclBefore.ok) {
        return @{
            ok     = $false
            method = 'grant'
            output = $OriginalOutput
            message = ($baseMessage + '; the object DACL could not be read (' + $aclBefore.message + '); ' + $guidance)
        }
    }
    $ownerInfo = Get-IntegrityObjectOwnerSid -Win32Path $Win32Path
    if (-not $ownerInfo.ok) {
        return @{
            ok     = $false
            method = 'grant'
            output = $OriginalOutput
            message = ($baseMessage + '; the object owner could not be read (' + $ownerInfo.message + '); ' + $guidance)
        }
    }
    $currentSid = Get-CurrentUserSid
    if ([string]::IsNullOrEmpty($currentSid)) {
        return @{
            ok     = $false
            method = 'grant'
            output = $OriginalOutput
            message = ($baseMessage + '; the current user SID is unknown; ' + $guidance)
        }
    }
    if (-not ([string]$ownerInfo.sid).Equals($currentSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        return @{
            ok     = $false
            method = 'grant'
            output = $OriginalOutput
            message = ($baseMessage + '; object owner ' + [string]$ownerInfo.sid + ' is not the current user ' + $currentSid + '; ' + $guidance)
        }
    }

    $toolPath = Get-IcaclsToolPath -NormalPath $NormalPath -Win32Path $Win32Path
    $grantArguments = (Quote-ProcessArgument $toolPath) + ' /grant *' + $currentSid + ':(WO)'
    $grantCall = Invoke-IcaclsProcess -Executable $script:IcaclsExecutable -ArgumentString $grantArguments
    if ($grantCall.exitCode -ne 0) {
        $aclAfterGrant = Get-IntegrityObjectDaclSddl -Win32Path $Win32Path
        $daclUnchanged = ($aclAfterGrant.ok -and ([string]$aclAfterGrant.sddl -eq [string]$aclBefore.sddl))
        $suffix = ''
        if (-not $daclUnchanged) {
            $suffix = '; warning: the DACL changed while attempting the temporary grant, inspect it manually'
        }
        return @{
            ok     = $false
            method = 'grant'
            output = (($OriginalOutput + ' ' + $grantCall.output).Trim())
            message = ($baseMessage + '; temporary WRITE_OWNER grant failed (icacls exit ' + $grantCall.exitCode + ')' + $suffix + '; ' + $guidance)
        }
    }

    $labelSet = $false
    $labelOutput = ''
    $labelMessage = ''
    $removeCall = $null
    try {
        $levelSpecification = $TargetLevel
        if ($Kind -eq 'dir') { $levelSpecification = '(OI)(CI)' + $TargetLevel }
        $setArguments = (Quote-ProcessArgument $toolPath) + ' /setintegritylevel ' + (Quote-ProcessArgument $levelSpecification)
        $setCall = Invoke-IcaclsProcess -Executable $script:IcaclsExecutable -ArgumentString $setArguments
        if ($setCall.exitCode -eq 0) {
            $labelSet = $true
        } else {
            $labelOutput = $setCall.output
            try {
                $sddlLevel = ConvertTo-SddlLevelAbbreviation $TargetLevel
                if ($Kind -eq 'dir') {
                    $sddl = 'S:(ML;OICI;NW;;;' + $sddlLevel + ')'
                } else {
                    $sddl = 'S:(ML;;NW;;;' + $sddlLevel + ')'
                }
                $nativeResult = [DshIntegrity.Native]::SetLabel($Win32Path, $sddl)
                if ($nativeResult -eq 0) {
                    $labelSet = $true
                } else {
                    $labelMessage = 'the label could not be set even with a temporary WRITE_OWNER grant (icacls exit ' + $setCall.exitCode + '; P/Invoke Win32 ' + $nativeResult + ')'
                }
            } catch {
                $labelMessage = 'the label could not be set even with a temporary WRITE_OWNER grant: ' + $_.Exception.Message
            }
        }
    } finally {
        $removeArguments = (Quote-ProcessArgument $toolPath) + ' /remove:g *' + $currentSid
        $removeCall = Invoke-IcaclsProcess -Executable $script:IcaclsExecutable -ArgumentString $removeArguments
    }
    $removeOutput = ''
    if ($null -ne $removeCall) { $removeOutput = [string]$removeCall.output }
    $combinedOutput = (($OriginalOutput + ' ' + $labelOutput + ' ' + $removeOutput).Trim())

    $aclAfter = Get-IntegrityObjectDaclSddl -Win32Path $Win32Path
    $daclRestored = ($aclAfter.ok -and ([string]$aclAfter.sddl -eq [string]$aclBefore.sddl))
    if (-not $daclRestored) {
        $afterText = 'unreadable'
        if ($aclAfter.ok) { $afterText = [string]$aclAfter.sddl }
        return @{
            ok     = $false
            method = 'grant'
            output = $combinedOutput
            message = ($baseMessage + '; the temporary WRITE_OWNER grant was not fully reverted (DACL changed); guidance: inspect and restore the ACL manually. before=' + [string]$aclBefore.sddl + ' after=' + $afterText)
        }
    }
    if (-not $labelSet) {
        if (-not $labelMessage) { $labelMessage = 'the label could not be set after a temporary WRITE_OWNER grant' }
        return @{
            ok     = $false
            method = 'grant'
            output = $combinedOutput
            message = ($baseMessage + '; ' + $labelMessage + '; ' + $guidance)
        }
    }
    return @{
        ok     = $true
        method = 'grant'
        output = $combinedOutput
        message = 'access denied; temporary WRITE_OWNER grant used and DACL restored'
        icaclsExitCode = 0
    }
}

function Repair-SingleObject {
    param([hashtable]$Hit, [string]$TargetLevel)
    $before = Get-IntegrityLabelInfo -Win32Path $Hit.win32Path
    if ($before.ok -and $before.level -ne 'Low') {
        return @{ status = 'already' }
    }
    $preReadMessage = ''
    if (-not $before.ok) { $preReadMessage = 'pre-read failed: ' + $before.message }

    $setResult = Set-IntegrityLevelOnPath -NormalPath $Hit.path -Win32Path $Hit.win32Path -Kind $Hit.kind -TargetLevel $TargetLevel
    $after = Get-IntegrityLabelInfo -Win32Path $Hit.win32Path
    if ($after.ok -and $after.level -eq $TargetLevel) {
        return @{ status = 'fixed'; method = $setResult.method; output = $setResult.output }
    }

    $message = ''
    if ($setResult.ok) {
        if (-not $after.ok) {
            $message = 'label re-read failed after set: ' + $after.message
        } else {
            $message = 'label is still ' + $after.level + ' after set'
        }
    } else {
        $message = $setResult.message
    }
    if ($preReadMessage) { $message = $message + ' (' + $preReadMessage + ')' }
    return @{
        status  = 'failed'
        method  = $setResult.method
        message = $message
        output  = $setResult.output
    }
}

# ---------------------------------------------------------------------------
# Traversal.
# ---------------------------------------------------------------------------
function Invoke-Traversal {
    param(
        [string]$RootNormal,
        [string[]]$SkipDirNames,
        [bool]$StreamHits,
        [System.Collections.ArrayList]$HitCollector,
        [string]$ProgressPhase,
        [string[]]$ExcludePaths = @()
    )
    $skipLookup = @{}
    foreach ($name in @($SkipDirNames)) {
        if ($null -ne $name) {
            $text = ([string]$name).Trim()
            if ($text.Length -gt 0) { $skipLookup[$text.ToLowerInvariant()] = $true }
        }
    }
    $excludePrefixes = New-Object System.Collections.ArrayList
    foreach ($excludedPath in @($ExcludePaths)) {
        if ($null -eq $excludedPath) { continue }
        $excludedText = ([string]$excludedPath).Trim()
        if ($excludedText.Length -eq 0) { continue }
        $excludedText = $excludedText.TrimEnd('\')
        if ($excludedText.Length -gt 0) { [void]$excludePrefixes.Add($excludedText.ToLowerInvariant()) }
    }

    $errors = New-Object System.Collections.ArrayList
    $state = @{
        scanned        = 0
        hits           = 0
        explicitCount  = 0
        inheritedCount = 0
        rootLabel      = 'Unknown'
        truncated      = $false
    }

    $rootWin32 = Get-Win32Path $RootNormal
    $stack = New-Object System.Collections.Stack
    $stack.Push($rootWin32)
    $isRootItem = $true

    $lastProgressAt = [DateTime]::UtcNow
    $sinceProgress = 0

    while ($stack.Count -gt 0) {
        $currentWin32 = [string]$stack.Pop()
        $currentIsRoot = $isRootItem
        $isRootItem = $false
        $currentNormal = ConvertTo-NormalPath $currentWin32

        if (-not $currentIsRoot -and $excludePrefixes.Count -gt 0) {
            $currentLower = $currentNormal.ToLowerInvariant()
            $isExcluded = $false
            foreach ($prefix in $excludePrefixes) {
                if ($currentLower -eq $prefix -or $currentLower.StartsWith($prefix + '\')) {
                    $isExcluded = $true
                    break
                }
            }
            if ($isExcluded) { continue }
        }

        $attributes = $null
        $isDirectory = $false
        $isReparsePoint = $false
        try {
            $attributes = [System.IO.File]::GetAttributes($currentWin32)
            $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
            $isReparsePoint = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        } catch {
            [void]$errors.Add(@{ path = $currentNormal; message = $_.Exception.Message })
            $state.scanned = $state.scanned + 1
            continue
        }

        if ($isDirectory -and -not $currentIsRoot) {
            $leaf = Get-PathLeaf $currentNormal
            if ($leaf) {
                if ($skipLookup.ContainsKey($leaf.ToLowerInvariant())) {
                    continue
                }
            }
        }

        $kind = 'file'
        if ($isDirectory) { $kind = 'dir' }

        $label = Get-IntegrityLabelInfo -Win32Path $currentWin32
        if ($label.ok) {
            if ($currentIsRoot) { $state.rootLabel = $label.level }
            if ($label.level -eq 'Low') {
                $state.hits = $state.hits + 1
                if ($label.explicit) { $state.explicitCount = $state.explicitCount + 1 }
                else { $state.inheritedCount = $state.inheritedCount + 1 }
                $hit = @{
                    path      = $currentNormal
                    win32Path = $currentWin32
                    kind      = $kind
                    explicit  = [bool]$label.explicit
                    inherited = [bool]$label.inherited
                    sddl      = $label.sddl
                    depth     = (Get-PathDepth $currentNormal)
                }
                if ($StreamHits) { Write-HitEvent -Hit $hit }
                if ($null -ne $HitCollector) { [void]$HitCollector.Add($hit) }
            }
        } else {
            [void]$errors.Add(@{ path = $currentNormal; message = $label.message })
            if ($currentIsRoot) { $state.rootLabel = 'Unknown' }
        }

        if ($isDirectory -and -not $isReparsePoint) {
            $children = $null
            try {
                $children = [System.IO.Directory]::GetFileSystemEntries($currentWin32)
            } catch {
                [void]$errors.Add(@{ path = $currentNormal; message = $_.Exception.Message })
                $children = $null
            }
            if ($null -ne $children) {
                [Array]::Sort($children, [System.StringComparer]::OrdinalIgnoreCase)
                for ($index = $children.Length - 1; $index -ge 0; $index--) {
                    $stack.Push($children[$index])
                }
            }
        }

        $state.scanned = $state.scanned + 1
        $sinceProgress = $sinceProgress + 1

        if ($state.scanned -ge $script:MaxScannedItems) {
            $state.truncated = $true
            break
        }

        $now = [DateTime]::UtcNow
        $shouldReport = $false
        if ($sinceProgress -ge 200) { $shouldReport = $true }
        elseif (($now - $lastProgressAt).TotalMilliseconds -ge 250) { $shouldReport = $true }
        if ($shouldReport) {
            Write-ProgressEvent -Phase $ProgressPhase -Scanned $state.scanned -Total $null -Hits $state.hits
            $lastProgressAt = $now
            $sinceProgress = 0
        }
    }

    if ($state.scanned -gt 0) {
        Write-ProgressEvent -Phase $ProgressPhase -Scanned $state.scanned -Total $null -Hits $state.hits
    }

    return @{
        scanned        = $state.scanned
        hits           = $state.hits
        explicitCount  = $state.explicitCount
        inheritedCount = $state.inheritedCount
        rootLabel      = $state.rootLabel
        errors         = $errors
        truncated      = [bool]$state.truncated
        hitList        = $HitCollector
    }
}

function ConvertTo-ResultErrors {
    param($ErrorList)
    $list = New-Object System.Collections.ArrayList
    $count = 0
    $truncated = $false
    if ($null -ne $ErrorList) {
        foreach ($entry in $ErrorList) {
            if ($count -ge $script:MaxErrorsInResult) {
                $truncated = $true
                break
            }
            [void]$list.Add(@{ path = [string]$entry.path; message = [string]$entry.message })
            $count = $count + 1
        }
    }
    return @{ list = $list; truncated = $truncated }
}

# ---------------------------------------------------------------------------
# Modes.
# ---------------------------------------------------------------------------
function Invoke-EnvMode {
    $user = 'Unknown'
    try { $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { }

    $integrity = Get-CurrentIntegrityName
    $powershellVersion = ''
    try { $powershellVersion = $PSVersionTable.PSVersion.ToString() } catch { }
    $icaclsExecutable = Resolve-IcaclsExecutable -Candidate $IcaclsPath
    $canWriteLabel = Test-CanWriteLabel -IcaclsExecutable $icaclsExecutable

    Write-Event -Fields ([ordered]@{
            type              = 'env'
            user              = $user
            integrity         = $integrity
            powershellVersion = $powershellVersion
            icaclsPath        = $icaclsExecutable
            canWriteLabel     = [bool]$canWriteLabel
        })
    return 0
}

function Test-RootArgument {
    if ([string]::IsNullOrEmpty($Root)) {
        Write-Fatal -Code 'invalid-arguments' -Message '-Root is required for Scan/Repair.'
        return @{ ok = $false }
    }
    $rootNormal = Resolve-RootPath -Path $Root
    if ([string]::IsNullOrEmpty($rootNormal)) {
        Write-Fatal -Code 'invalid-arguments' -Message 'Invalid -Root value.'
        return @{ ok = $false }
    }
    $rootWin32 = Get-Win32Path $rootNormal
    try {
        [void][System.IO.File]::GetAttributes($rootWin32)
    } catch {
        Write-Fatal -Code 'root-not-found' -Message ('Root does not exist or is inaccessible: ' + $rootNormal)
        return @{ ok = $false }
    }
    return @{ ok = $true; rootNormal = $rootNormal; rootWin32 = $rootWin32 }
}

function Invoke-ScanMode {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $rootCheck = Test-RootArgument
    if (-not $rootCheck.ok) { return 3 }

    $scan = Invoke-Traversal -RootNormal $rootCheck.rootNormal -SkipDirNames $script:SkipDirList -StreamHits $true -HitCollector $null -ProgressPhase 'enumerate'

    $convertedErrors = ConvertTo-ResultErrors -ErrorList $scan.errors
    $truncated = ([bool]$scan.truncated) -or ([bool]$convertedErrors.truncated)

    Write-Event -Fields ([ordered]@{
            type           = 'result'
            mode           = 'scan'
            root           = $rootCheck.rootNormal
            rootLabel      = $scan.rootLabel
            scanned        = $scan.scanned
            hits           = $scan.hits
            explicitCount  = $scan.explicitCount
            inheritedCount = $scan.inheritedCount
            errors         = $convertedErrors.list
            truncated      = [bool]$truncated
            engineVersion  = $script:EngineVersion
            durationMs     = [int]$stopwatch.ElapsedMilliseconds
        })

    if ($scan.hits -gt 0) { return 2 }
    return 0
}

function Get-SnapshotTargets {
    param([System.Collections.ArrayList]$Hits)
    $targets = New-Object System.Collections.ArrayList
    foreach ($hit in $Hits) {
        [void]$targets.Add([ordered]@{
                path     = $hit.path
                kind     = $hit.kind
                explicit = [bool]$hit.explicit
                label    = 'Low'
                sddl     = $hit.sddl
            })
    }
    return $targets
}

function New-RestoreScriptText {
    param([System.Collections.ArrayList]$Hits, [string]$RootPath, [string]$SnapshotPath)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.AppendLine('# dsh-file-integrity-check restore script')
    [void]$builder.AppendLine('# Generated: ' + (Get-Date).ToString('o'))
    [void]$builder.AppendLine('# Root: ' + $RootPath)
    [void]$builder.AppendLine('# Snapshot: ' + $SnapshotPath)
    [void]$builder.AppendLine('#')
    [void]$builder.AppendLine('# Restores the effective Low integrity label of EVERY hit captured before repair')
    [void]$builder.AppendLine('# (explicit and inherited Low entries alike). Inherited entries are restored as')
    [void]$builder.AppendLine('# explicit Low labels: the effective label state is restored, while the original')
    [void]$builder.AppendLine('# inheritance chain is not reconstructed.')
    [void]$builder.AppendLine('#')
    [void]$builder.AppendLine('# If a label write is denied because the DACL does not grant WRITE_OWNER (typical')
    [void]$builder.AppendLine('# for objects created by a sandboxed/AppContainer process), the script temporarily')
    [void]$builder.AppendLine('# grants WRITE_OWNER to the current user, sets the label, then removes the grant')
    [void]$builder.AppendLine('# again and warns if the DACL could not be restored.')
    [void]$builder.AppendLine('# Run as the same user (or with administrator rights), e.g.:')
    [void]$builder.AppendLine('#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<this script>"')
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine('param(')
    [void]$builder.AppendLine("    [string]`$IcaclsPath = 'icacls.exe'")
    [void]$builder.AppendLine(')')
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine("`$ErrorActionPreference = 'Continue'")
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine("`$currentSid = ''")
    [void]$builder.AppendLine('try {')
    [void]$builder.AppendLine("    `$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
    [void]$builder.AppendLine('} catch {')
    [void]$builder.AppendLine("    `$currentSid = ''")
    [void]$builder.AppendLine('}')
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine('$targets = @(')
    $targetLines = New-Object System.Collections.ArrayList
    foreach ($hit in $Hits) {
        $displayPath = ([string]$hit.path).Replace("'", "''")
        $toolPath = ([string]$hit.win32Path).Replace("'", "''")
        $kind = [string]$hit.kind
        [void]$targetLines.Add(("    @{{ Path = '{0}'; PathForTool = '{1}'; Kind = '{2}'; Level = 'Low' }}" -f $displayPath, $toolPath, $kind))
    }
    # Windows PowerShell 5.1 rejects a trailing comma inside array literals
    # ("$a = @(1,)" -> ParserError), so commas go between entries only.
    if ($targetLines.Count -gt 0) {
        [void]$builder.AppendLine(($targetLines -join (',' + [Environment]::NewLine)))
    }
    [void]$builder.AppendLine(')')
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine('foreach ($target in $targets) {')
    [void]$builder.AppendLine("    `$exists = `$false")
    [void]$builder.AppendLine("    if (`$target.Kind -eq 'dir') {")
    [void]$builder.AppendLine("        `$exists = [System.IO.Directory]::Exists(`$target.PathForTool)")
    [void]$builder.AppendLine('    } else {')
    [void]$builder.AppendLine("        `$exists = [System.IO.File]::Exists(`$target.PathForTool)")
    [void]$builder.AppendLine('    }')
    [void]$builder.AppendLine("    if (-not `$exists) {")
    [void]$builder.AppendLine("        Write-Warning ('skip missing: ' + `$target.Path)")
    [void]$builder.AppendLine('        continue')
    [void]$builder.AppendLine('    }')
    [void]$builder.AppendLine("    `$specification = `$target.Level")
    [void]$builder.AppendLine("    if (`$target.Kind -eq 'dir') { `$specification = '(OI)(CI)' + `$target.Level }")
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine("    `$setOutput = & `$IcaclsPath `$target.PathForTool /setintegritylevel `$specification 2>&1")
    [void]$builder.AppendLine('    $setExit = $LASTEXITCODE')
    [void]$builder.AppendLine("    `$setText = ((`$setOutput | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine).Trim()")
    [void]$builder.AppendLine('    if ($setExit -eq 0) {')
    [void]$builder.AppendLine("        Write-Host ('restored ' + `$target.Level + ': ' + `$target.Path)")
    [void]$builder.AppendLine('        continue')
    [void]$builder.AppendLine('    }')
    [void]$builder.AppendLine('')
    [void]$builder.AppendLine('    $restored = $false')
    [void]$builder.AppendLine('    $failureText = $setText')
    [void]$builder.AppendLine("    `$grantNote = ''")
    [void]$builder.AppendLine('    if (-not [string]::IsNullOrEmpty($currentSid)) {')
    [void]$builder.AppendLine('        $daclBefore = $null')
    [void]$builder.AppendLine("        try { `$daclBefore = (Get-Acl -LiteralPath `$target.Path).Sddl } catch { `$daclBefore = `$null }")
    [void]$builder.AppendLine("        `$grantOutput = & `$IcaclsPath `$target.PathForTool /grant ('*' + `$currentSid + ':(WO)') 2>&1")
    [void]$builder.AppendLine('        $grantExit = $LASTEXITCODE')
    [void]$builder.AppendLine("        `$grantText = ((`$grantOutput | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine).Trim()")
    [void]$builder.AppendLine('        if ($grantExit -eq 0) {')
    [void]$builder.AppendLine('            try {')
    [void]$builder.AppendLine("                `$retryOutput = & `$IcaclsPath `$target.PathForTool /setintegritylevel `$specification 2>&1")
    [void]$builder.AppendLine('                $retryExit = $LASTEXITCODE')
    [void]$builder.AppendLine("                `$retryText = ((`$retryOutput | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine).Trim()")
    [void]$builder.AppendLine('                if ($retryExit -eq 0) {')
    [void]$builder.AppendLine('                    $restored = $true')
    [void]$builder.AppendLine("                    `$grantNote = 'temporary WRITE_OWNER grant used'")
    [void]$builder.AppendLine('                } else {')
    [void]$builder.AppendLine("                    `$failureText = ((`$failureText + ' ; retry: ' + `$retryText)).Trim()")
    [void]$builder.AppendLine("                    `$grantNote = 'temporary WRITE_OWNER grant used but the label set failed'")
    [void]$builder.AppendLine('                }')
    [void]$builder.AppendLine('            } finally {')
    [void]$builder.AppendLine("                `$removeOutput = & `$IcaclsPath `$target.PathForTool /remove:g ('*' + `$currentSid) 2>&1")
    [void]$builder.AppendLine('                $removeExit = $LASTEXITCODE')
    [void]$builder.AppendLine("                `$removeText = ((`$removeOutput | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine).Trim()")
    [void]$builder.AppendLine('                if ($removeExit -ne 0) {')
    [void]$builder.AppendLine("                    Write-Warning ('temporary WRITE_OWNER grant removal failed: ' + `$target.Path + ' :: ' + `$removeText)")
    [void]$builder.AppendLine('                }')
    [void]$builder.AppendLine('                if ($null -ne $daclBefore) {')
    [void]$builder.AppendLine('                    try {')
    [void]$builder.AppendLine("                        `$daclAfter = (Get-Acl -LiteralPath `$target.Path).Sddl")
    [void]$builder.AppendLine('                        if ($daclAfter -ne $daclBefore) {')
    [void]$builder.AppendLine("                            Write-Warning ('temporary WRITE_OWNER grant could not be fully reverted (DACL changed): ' + `$target.Path)")
    [void]$builder.AppendLine('                        }')
    [void]$builder.AppendLine('                    } catch { }')
    [void]$builder.AppendLine('                }')
    [void]$builder.AppendLine('            }')
    [void]$builder.AppendLine('        } else {')
    [void]$builder.AppendLine("            `$grantNote = 'grant attempt failed: ' + `$grantText")
    [void]$builder.AppendLine('        }')
    [void]$builder.AppendLine('    }')
    [void]$builder.AppendLine('    if ($restored) {')
    [void]$builder.AppendLine("        Write-Host ('restored ' + `$target.Level + ': ' + `$target.Path + ' (' + `$grantNote + ')')")
    [void]$builder.AppendLine('    } else {')
    [void]$builder.AppendLine("        Write-Warning ('restore failed: ' + `$target.Path + ' :: ' + `$failureText + ' ; ' + `$grantNote + ' ; guidance: run as the object owner or with administrator rights, or set the label manually via icacls')")
    [void]$builder.AppendLine('    }')
    [void]$builder.AppendLine('}')
    [void]$builder.AppendLine("Write-Host ('Restore complete. Targets: ' + `$targets.Count)")
    return $builder.ToString()
}

function Invoke-RepairMode {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $rootCheck = Test-RootArgument
    if (-not $rootCheck.ok) { return 3 }

    # Resolve the snapshot base before scanning so that a -DataDir inside -Root is
    # excluded from the traversal (defensive; the Host normally keeps it outside).
    $dataDirectory = $DataDir
    if ([string]::IsNullOrEmpty($dataDirectory)) {
        $dataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-file-integrity-check'
    }
    try {
        $dataDirectory = [System.IO.Path]::GetFullPath($dataDirectory)
    } catch { }
    $repairExclusions = @()
    try {
        $rootLower = $rootCheck.rootNormal.ToLowerInvariant().TrimEnd('\')
        $dataLower = $dataDirectory.ToLowerInvariant().TrimEnd('\')
        if ($dataLower.Length -gt $rootLower.Length -and $dataLower.StartsWith($rootLower + '\')) {
            $repairExclusions = @($dataDirectory)
        }
    } catch { }

    $hits = New-Object System.Collections.ArrayList
    $scan = Invoke-Traversal -RootNormal $rootCheck.rootNormal -SkipDirNames $script:SkipDirList -StreamHits $true -HitCollector $hits -ProgressPhase 'enumerate' -ExcludePaths $repairExclusions

    $convertedErrors = ConvertTo-ResultErrors -ErrorList $scan.errors
    $truncated = ([bool]$scan.truncated) -or ([bool]$convertedErrors.truncated)

    if ($hits.Count -eq 0) {
        Write-Event -Fields ([ordered]@{
                type           = 'result'
                mode           = 'repair'
                root           = $rootCheck.rootNormal
                rootLabel      = $scan.rootLabel
                scanned        = $scan.scanned
                hits           = 0
                explicitCount  = 0
                inheritedCount = 0
                errors         = $convertedErrors.list
                truncated      = [bool]$truncated
                fixed          = 0
                failed         = (New-Object System.Collections.ArrayList)
                remaining      = 0
                snapshotPath   = $null
                restorePath    = $null
                engineVersion  = $script:EngineVersion
                durationMs     = [int]$stopwatch.ElapsedMilliseconds
            })
        return 0
    }

    # ---- snapshot + restore script, before any mutation --------------------
    $snapshotDirectory = Join-Path $dataDirectory 'snapshots'
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $snapshotPath = Join-Path $snapshotDirectory ('snapshot-' + $stamp + '.json')
    $restorePath = Join-Path $snapshotDirectory ('restore-' + $stamp + '.ps1')

    try {
        if (-not [System.IO.Directory]::Exists($snapshotDirectory)) {
            [System.IO.Directory]::CreateDirectory($snapshotDirectory) | Out-Null
        }
        $snapshotDocument = [ordered]@{
            version   = $script:EngineVersion
            createdAt = (Get-Date).ToString('o')
            root      = $rootCheck.rootNormal
            rootLabel = $scan.rootLabel
            hitCount  = $hits.Count
            hits      = (Get-SnapshotTargets -Hits $hits)
        }
        Write-TextFileNoBom -Path $snapshotPath -Text (ConvertTo-JsonValue $snapshotDocument)
        $restoreText = New-RestoreScriptText -Hits $hits -RootPath $rootCheck.rootNormal -SnapshotPath $snapshotPath
        Write-TextFileUtf8Bom -Path $restorePath -Text $restoreText
    } catch {
        Write-Fatal -Code 'snapshot-failed' -Message ('Could not write repair snapshot: ' + $_.Exception.Message)
        return 3
    }

    # ---- repair bookkeeping ------------------------------------------------
    $failed = New-Object System.Collections.ArrayList
    $attemptRecords = @{}
    $fixedCount = 0
    $processedCount = 0
    $methods = @{ icacls = 0; pinvoke = 0; grant = 0 }

    $recordFailureEvent = {
        param($hit, $message, $output)
        $key = $hit.path.ToLowerInvariant()
        $attemptRecords[$key] = @{ path = $hit.path; message = [string]$message; output = [string]$output }
        $text = [string]$message
        $text = $text -replace "`r?`n", ' '
        Write-Event -Fields ([ordered]@{
                type    = 'error'
                path    = $hit.path
                message = $text
                phase   = 'repair'
                output  = [string]$output
            })
    }

    $repairLayer = {
        param($layerItems, $layerLabel)
        if ($null -eq $layerItems) { return }
        $items = @($layerItems)
        if ($items.Count -eq 0) { return }
        $layerTotal = $items.Count
        $layerProcessed = 0
        foreach ($hit in $items) {
            $layerProcessed = $layerProcessed + 1
            $outcome = Repair-SingleObject -Hit $hit -TargetLevel 'Medium'
            if ($outcome.status -eq 'fixed') {
                if ($outcome.method) { if ($methods.ContainsKey($outcome.method)) { $methods[$outcome.method] = $methods[$outcome.method] + 1 } }
            } elseif ($outcome.status -eq 'failed') {
                & $recordFailureEvent $hit $outcome.message $outcome.output
            }
            Write-ProgressEvent -Phase 'repair' -Scanned $layerProcessed -Total $layerTotal -Hits $scan.hits
        }
        Write-ProgressEvent -Phase 'repair' -Scanned $layerTotal -Total $layerTotal -Hits $scan.hits
    }

    $explicitLowDirectories = @($hits | Where-Object { $_.kind -eq 'dir' -and $_.explicit } | Sort-Object -Property depth)
    $explicitLowFiles = @($hits | Where-Object { $_.kind -eq 'file' -and $_.explicit } | Sort-Object -Property depth)
    & $repairLayer $explicitLowDirectories 'explicit-dirs'
    & $repairLayer $explicitLowFiles 'explicit-files'

    # ---- fallback: rescan and repair anything still Low --------------------
    $rescanHits = New-Object System.Collections.ArrayList
    $rescan = Invoke-Traversal -RootNormal $rootCheck.rootNormal -SkipDirNames $script:SkipDirList -StreamHits $false -HitCollector $rescanHits -ProgressPhase 'repair' -ExcludePaths $repairExclusions
    $rescanDirectories = @($rescanHits | Where-Object { $_.kind -eq 'dir' } | Sort-Object -Property depth)
    $rescanFiles = @($rescanHits | Where-Object { $_.kind -eq 'file' } | Sort-Object -Property depth)
    & $repairLayer $rescanDirectories 'fallback-dirs'
    & $repairLayer $rescanFiles 'fallback-files'

    # ---- final verification of the original hit set -----------------------
    # result.failed is the FINAL failure list: only objects that are still Low
    # (or can no longer be verified) after all repair layers are reported. Failed
    # attempts that were later fixed by propagation are not listed here.
    $remainingCount = 0
    $verifyFailures = 0
    $verifiedCount = 0
    $finalProblems = @{}
    foreach ($hit in $hits) {
        $verifiedCount = $verifiedCount + 1
        $key = $hit.path.ToLowerInvariant()
        $info = Get-IntegrityLabelInfo -Win32Path $hit.win32Path
        if (-not $info.ok) {
            $verifyFailures = $verifyFailures + 1
            $finalProblems[$key] = @{ state = 'verify-failed'; message = ('verification failed: ' + $info.message) }
        } elseif ($info.level -eq 'Low') {
            $remainingCount = $remainingCount + 1
            $finalProblems[$key] = @{ state = 'still-low'; message = 'still Low after repair' }
        }
        if (($verifiedCount % 200) -eq 0) {
            Write-ProgressEvent -Phase 'verify' -Scanned $verifiedCount -Total $hits.Count -Hits $scan.hits
        }
    }
    Write-ProgressEvent -Phase 'verify' -Scanned $hits.Count -Total $hits.Count -Hits $scan.hits

    # failure list = original hits that are still Low / unverifiable
    foreach ($hit in $hits) {
        $key = $hit.path.ToLowerInvariant()
        if (-not $finalProblems.ContainsKey($key)) { continue }
        $problem = $finalProblems[$key]
        $message = [string]$problem.message
        $output = ''
        $record = $attemptRecords[$key]
        if ($null -ne $record) {
            if ($record.message) { $message = [string]$record.message }
            $output = [string]$record.output
        }
        [void]$failed.Add([ordered]@{
                path    = $hit.path
                message = $message
                output  = $output
            })
    }

    $fixedCount = $hits.Count - $remainingCount - $verifyFailures
    if ($fixedCount -lt 0) { $fixedCount = 0 }

    $fixedCount = $hits.Count - $remainingCount - $verifyFailures
    if ($fixedCount -lt 0) { $fixedCount = 0 }

    Write-Event -Fields ([ordered]@{
            type           = 'result'
            mode           = 'repair'
            root           = $rootCheck.rootNormal
            rootLabel      = $scan.rootLabel
            scanned        = $scan.scanned
            hits           = $scan.hits
            explicitCount  = $scan.explicitCount
            inheritedCount = $scan.inheritedCount
            errors         = $convertedErrors.list
            truncated      = [bool]$truncated
            fixed          = $fixedCount
            failed         = $failed
            remaining      = $remainingCount
            methods        = ([ordered]@{ icacls = $methods['icacls']; pinvoke = $methods['pinvoke']; grant = $methods['grant'] })
            snapshotPath   = $snapshotPath
            restorePath    = $restorePath
            engineVersion  = $script:EngineVersion
            durationMs     = [int]$stopwatch.ElapsedMilliseconds
        })

    if ($remainingCount -gt 0 -or $failed.Count -gt 0) { return 2 }
    return 0
}

# ---------------------------------------------------------------------------
# Argument normalization / entry point.
# ---------------------------------------------------------------------------
$script:SkipDirList = New-Object System.Collections.ArrayList
foreach ($entry in @($SkipDirs)) {
    if ($null -eq $entry) { continue }
    foreach ($part in ([string]$entry).Split(',')) {
        $trimmed = $part.Trim()
        if ($trimmed.Length -gt 0) { [void]$script:SkipDirList.Add($trimmed) }
    }
}
$script:SkipDirList = @($script:SkipDirList)

$script:IcaclsExecutable = Resolve-IcaclsExecutable -Candidate $IcaclsPath

$exitCode = 3
try {
    switch ($Mode) {
        'Env' { $exitCode = Invoke-EnvMode }
        'Scan' { $exitCode = Invoke-ScanMode }
        'Repair' { $exitCode = Invoke-RepairMode }
        default {
            Write-Fatal -Code 'invalid-arguments' -Message ('Unknown mode: ' + $Mode)
            $exitCode = 3
        }
    }
} catch {
    $message = $_.Exception.Message
    if ($null -eq $message) { $message = 'unknown error' }
    Write-Fatal -Code 'internal-error' -Message $message
    $exitCode = 3
} finally {
    try { $script:Out.Flush() } catch { }
}

exit $exitCode
