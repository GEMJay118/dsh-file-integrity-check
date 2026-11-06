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
             "error" line and do not abort the scan. When the scan finishes, the full
             hit report is written to <DataDir>\reports\scan-<timestamp>.json and
             result.reportPath points at it (the Host can export that file directly).
             -ScanDepth quick (default) uses the embedded C# scanner; deep keeps the
             legacy PowerShell traversal.
    Repair - scan first (streaming hit lines), snapshot every hit into
             <DataDir>\snapshots\snapshot-*.json plus a restore-*.ps1 script, then repair:
               1. explicit-Low directories (shallowest first), icacls "(OI)(CI)Medium"
               2. explicit-Low files, icacls "Medium"
               3. rescan; any object still Low is repaired individually as a fallback
             The repair does not assume that inherited-Low children recover when their
             parent is repaired: the rescan step repairs every remaining object.
             Fast path: each object is repaired in-process with SetNamedSecurityInfoW
             (no icacls process). When that is denied because the object DACL does not
             grant WRITE_OWNER (typical for objects created by a sandboxed/AppContainer
             process), the engine saves the DACL, inserts a temporary WRITE_OWNER allow
             ACE for the current owner, sets the label, restores the original DACL and
             verifies the restored DACL byte-for-byte - all in-process, no icacls spawn.
             This only runs when the current user owns the object. If the in-process
             paths fail, the legacy icacls based fallback runs to produce a readable
             error. Non-hit objects are never modified. A final verification pass over
             the original hit set produces the "failed" / "remaining" result fields.
             result.methods reports icacls / pinvoke / grant / native counts.
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

.PARAMETER ScanDepth
  Scan implementation / output depth for -Mode Scan. Default: quick.
    quick - embedded C# scanner (single process, FindFirstFileExW + per-object
            GetNamedSecurityInfoW/ConvertSecurityDescriptorToStringSecurityDescriptorW,
            label parsed in C#). Streams "hit" lines only for EXPLICIT Low objects
            (inherited Low objects are counted, not emitted). result carries
            depth:"quick", engine:"csharp", scanMs.
    deep  - legacy PowerShell traversal; streams every Low hit and behaves exactly
            like previous engine versions. result carries depth:"deep",
            engine:"powershell".
  -Mode Env and -Mode Repair are unaffected by this switch (Repair keeps the deep
  PowerShell traversal so the snapshot/repair logic stays unchanged).

.PARAMETER IcaclsPath
  icacls executable (test seam). Default: icacls.exe resolved from PATH/System32.

.PARAMETER DataDir
  Engine data directory. Repair writes snapshots and restore scripts to
  <DataDir>\snapshots\; Scan writes its complete hit report to <DataDir>\reports\
  as scan-<timestamp>.json (result.reportPath). Default:
  <temp>\dsh-file-integrity-check.

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

    [ValidateSet('quick', 'deep')]
    [string]$ScanDepth = 'quick',

    [string]$IcaclsPath = 'icacls.exe',

    [string]$DataDir,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$script:EngineVersion = '0.1.0'
$script:MaxScannedItems = 1000000
$script:MaxErrorsInResult = 1000
$script:MaxReportItems = 50000
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

        public static string GetLabelLevel(string path, out int errorCode)
        {
            string sddl = GetLabelSddl(path, out errorCode);
            if (sddl == null) return null;
            return ParseLabelLevelSddl(sddl);
        }

        private static string ParseLabelLevelSddl(string sddl)
        {
            if (sddl == null || sddl.Length == 0) return "None";
            string explicitLevel = null;
            string inheritedLevel = null;
            int index = 0;
            while (index < sddl.Length)
            {
                int open = sddl.IndexOf('(', index);
                if (open < 0) break;
                int close = sddl.IndexOf(')', open + 1);
                if (close < 0) break;
                string ace = sddl.Substring(open + 1, close - open - 1);
                if (ace.StartsWith("ML;", StringComparison.Ordinal))
                {
                    string[] parts = ace.Split(';');
                    if (parts.Length >= 6)
                    {
                        bool inherited = (parts[1].IndexOf("ID", StringComparison.Ordinal) >= 0);
                        string level = LevelFromSidName(parts[5]);
                        if (inherited)
                        {
                            if (inheritedLevel == null) inheritedLevel = level;
                        }
                        else
                        {
                            if (explicitLevel == null) explicitLevel = level;
                        }
                    }
                }
                index = close + 1;
            }
            if (explicitLevel != null) return explicitLevel;
            if (inheritedLevel != null) return inheritedLevel;
            return "None";
        }

        private static string LevelFromSidName(string sid)
        {
            if (sid == null) return "None";
            if (sid == "LW") return "Low";
            if (sid == "ME") return "Medium";
            if (sid == "HI") return "High";
            if (sid == "SI") return "System";
            if (sid.StartsWith("S-1-16-", StringComparison.Ordinal))
            {
                int rid = 0;
                if (int.TryParse(sid.Substring(7), out rid))
                {
                    switch (rid)
                    {
                        case 0: return "Untrusted";
                        case 4096: return "Low";
                        case 8192: return "Medium";
                        case 12288: return "High";
                        case 16384: return "System";
                        case 20480: return "Protected";
                        default: return "S-1-16-" + rid.ToString();
                    }
                }
            }
            return sid;
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

        // ------------------------------------------------------------------
        // Fast repair path: in-process SetNamedSecurityInfoW(LABEL) and, when
        // the object DACL does not grant WRITE_OWNER, an in-process temporary
        // DACL grant that is reverted and verified before returning.
        // ------------------------------------------------------------------
        private const uint DaclSecurityInformation = 0x00000004;
        private const uint ProtectedDaclSecurityInformation = 0x80000000;
        private const uint WriteOwnerAccess = 0x00080000;
        private const int GrantAccess = 1;
        private const int TrusteeFormIsSid = 0;
        private const int TrusteeTypeIsUser = 1;
        private const uint NoInheritance = 0;
        private const ushort SeDaclProtected = 0x1000;

        private static IntPtr mediumFileSacl = IntPtr.Zero;
        private static IntPtr mediumDirectorySacl = IntPtr.Zero;
        private static IntPtr mediumFileSecurityDescriptor = IntPtr.Zero;
        private static IntPtr mediumDirectorySecurityDescriptor = IntPtr.Zero;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct TRUSTEE
        {
            public IntPtr pMultipleTrustee;
            public int MultipleTrusteeOperation;
            public int TrusteeForm;
            public int TrusteeType;
            public IntPtr ptstrName;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct EXPLICIT_ACCESS
        {
            public uint grfAccessPermissions;
            public int grfAccessMode;
            public uint grfInheritance;
            public TRUSTEE Trustee;
        }

        [DllImport("advapi32.dll", EntryPoint = "GetNamedSecurityInfoW", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetNamedSecurityInfoWithDaclW(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            IntPtr ppsidOwner,
            IntPtr ppsidGroup,
            out IntPtr ppDacl,
            IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr pSecurityDescriptor,
            out bool lpbDaclPresent,
            out IntPtr pDacl,
            out bool lpbDaclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetSecurityDescriptorControl(
            IntPtr pSecurityDescriptor,
            out ushort pControl,
            out uint lpdwRevision);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool ConvertStringSidToSidW(string StringSid, out IntPtr Sid);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint SetEntriesInAclW(
            int cCountOfExplicitEntries,
            ref EXPLICIT_ACCESS pListOfExplicitEntries,
            IntPtr OldAcl,
            out IntPtr NewAcl);

        public sealed class GrantSetResult
        {
            public int LabelCode;
            public int GrantCode;
            public int RestoreCode;
            public int DaclErrorCode;
            public int DaclAfterErrorCode;
            public bool DaclRestored;
            public string DaclBefore;
            public string DaclAfter;
            public string Message;
        }

        private static IntPtr GetMediumSacl(bool isDirectory)
        {
            if (isDirectory)
            {
                if (mediumDirectorySacl == IntPtr.Zero)
                {
                    BuildMediumSecurityDescriptor(true, out mediumDirectorySecurityDescriptor, out mediumDirectorySacl);
                }
                return mediumDirectorySacl;
            }
            if (mediumFileSacl == IntPtr.Zero)
            {
                BuildMediumSecurityDescriptor(false, out mediumFileSecurityDescriptor, out mediumFileSacl);
            }
            return mediumFileSacl;
        }

        private static void BuildMediumSecurityDescriptor(bool isDirectory, out IntPtr securityDescriptor, out IntPtr sacl)
        {
            securityDescriptor = IntPtr.Zero;
            sacl = IntPtr.Zero;
            string sddl = isDirectory ? "S:(ML;OICI;NW;;;ME)" : "S:(ML;;NW;;;ME)";
            IntPtr built;
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SddlRevision1, out built, out size))
            {
                return;
            }
            bool present;
            IntPtr acl;
            bool defaulted;
            if (!GetSecurityDescriptorSacl(built, out present, out acl, out defaulted) || !present || acl == IntPtr.Zero)
            {
                LocalFree(built);
                return;
            }
            securityDescriptor = built;
            sacl = acl;
        }

        public static int SetLabelToMedium(string path, bool isDirectory)
        {
            IntPtr sacl = GetMediumSacl(isDirectory);
            if (sacl == IntPtr.Zero)
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

        public static GrantSetResult SetLabelToMediumWithTemporaryGrant(string path, bool isDirectory, string userSid)
        {
            GrantSetResult result = new GrantSetResult();
            result.LabelCode = -1;
            result.GrantCode = -1;
            result.RestoreCode = -1;
            result.DaclBefore = GetDaclSddl(path, out result.DaclErrorCode);

            IntPtr securityDescriptor = IntPtr.Zero;
            IntPtr sid = IntPtr.Zero;
            IntPtr newAcl = IntPtr.Zero;
            bool daclPresent = false;
            IntPtr originalDacl = IntPtr.Zero;
            bool daclDefaulted = false;
            ushort control = 0;
            uint revision = 0;
            bool grantApplied = false;

            try
            {
                uint getResult = GetNamedSecurityInfoWithDaclW(
                    path,
                    SeFileObject,
                    DaclSecurityInformation,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    out originalDacl,
                    IntPtr.Zero,
                    out securityDescriptor);
                if (getResult != 0)
                {
                    result.Message = "GetNamedSecurityInfoW(DACL) failed: Win32 " + getResult.ToString();
                    return result;
                }
                if (!GetSecurityDescriptorDacl(securityDescriptor, out daclPresent, out originalDacl, out daclDefaulted))
                {
                    result.Message = "GetSecurityDescriptorDacl failed: Win32 " + Marshal.GetLastWin32Error().ToString();
                    return result;
                }
                GetSecurityDescriptorControl(securityDescriptor, out control, out revision);
                bool daclProtected = ((control & SeDaclProtected) != 0);

                if (!ConvertStringSidToSidW(userSid, out sid))
                {
                    result.Message = "ConvertStringSidToSidW failed: Win32 " + Marshal.GetLastWin32Error().ToString();
                    return result;
                }

                EXPLICIT_ACCESS explicitAccess = new EXPLICIT_ACCESS();
                explicitAccess.grfAccessPermissions = WriteOwnerAccess;
                explicitAccess.grfAccessMode = GrantAccess;
                explicitAccess.grfInheritance = NoInheritance;
                explicitAccess.Trustee.pMultipleTrustee = IntPtr.Zero;
                explicitAccess.Trustee.MultipleTrusteeOperation = 0;
                explicitAccess.Trustee.TrusteeForm = TrusteeFormIsSid;
                explicitAccess.Trustee.TrusteeType = TrusteeTypeIsUser;
                explicitAccess.Trustee.ptstrName = sid;

                uint aclResult = SetEntriesInAclW(1, ref explicitAccess, daclPresent ? originalDacl : IntPtr.Zero, out newAcl);
                if (aclResult != 0)
                {
                    result.GrantCode = unchecked((int)aclResult);
                    result.Message = "SetEntriesInAclW failed: Win32 " + aclResult.ToString();
                    return result;
                }

                uint securityInformation = DaclSecurityInformation | ProtectedDaclSecurityInformation;
                uint grantResult = SetNamedSecurityInfoW(
                    path,
                    SeFileObject,
                    securityInformation,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    newAcl,
                    IntPtr.Zero);
                result.GrantCode = unchecked((int)grantResult);
                if (grantResult != 0)
                {
                    result.Message = "applying temporary DACL grant failed: Win32 " + grantResult.ToString();
                    return result;
                }
                grantApplied = true;
                result.LabelCode = SetLabelToMedium(path, isDirectory);
            }
            finally
            {
                if (grantApplied)
                {
                    uint restoreInformation = DaclSecurityInformation;
                    if ((control & SeDaclProtected) != 0) restoreInformation = restoreInformation | ProtectedDaclSecurityInformation;
                    IntPtr restoreDacl = daclPresent ? originalDacl : IntPtr.Zero;
                    uint restoreResult = SetNamedSecurityInfoW(
                        path,
                        SeFileObject,
                        restoreInformation,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        restoreDacl,
                        IntPtr.Zero);
                    result.RestoreCode = unchecked((int)restoreResult);
                    result.DaclAfter = GetDaclSddl(path, out result.DaclAfterErrorCode);
                    result.DaclRestored = (restoreResult == 0) &&
                        (result.DaclBefore != null) &&
                        (result.DaclAfter != null) &&
                        string.Equals(result.DaclBefore, result.DaclAfter, StringComparison.Ordinal);
                }
                else
                {
                    // The grant was never applied, so the DACL cannot have changed.
                    result.DaclAfter = result.DaclBefore;
                    result.DaclRestored = true;
                }
                if (newAcl != IntPtr.Zero) LocalFree(newAcl);
                if (sid != IntPtr.Zero) LocalFree(sid);
                if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor);
            }
            return result;
        }

        public static string GetTokenIntegritySid()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token))
            {
                return null;            }
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
# Embedded C# quick scanner (-ScanDepth quick).
# Enumerates with FindFirstFileExW, reads the mandatory label per object with
# GetNamedSecurityInfoW + ConvertSecurityDescriptorToStringSecurityDescriptorW,
# parses the ML ACE (LW/ME/HI/SI + ID inherited flag) directly in C# and only
# returns the EXPLICIT Low hits. Compiled lazily so Env / Repair / deep scans do
# not pay the Add-Type cost.
# ---------------------------------------------------------------------------
$script:QuickScannerTypeCode = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DshIntegrity
{
    public sealed class QuickScanHit
    {
        public string Path;
        public string Kind;
        public bool Explicit;
        public bool Inherited;
        public string Sddl;
    }

    public sealed class QuickScanError
    {
        public string Path;
        public string Message;
    }

    public sealed class QuickScanResult
    {
        public int Scanned;
        public int Hits;
        public int ExplicitCount;
        public int InheritedCount;
        public string RootLabel;
        public bool Truncated;
        public long ScanMs;
        public List<QuickScanHit> ExplicitHits = new List<QuickScanHit>();
        public List<QuickScanError> Errors = new List<QuickScanError>();
    }

    public static class QuickScanner
    {
        private const int SeFileObject = 1;
        private const uint LabelSecurityInformation = 0x00000010;
        private const uint SddlRevision1 = 1;

        private const int MaxExplicitHits = 5000;
        private const int MaxErrors = 500;
        private const int ProgressItemStep = 2000;
        private const int ProgressMillisecondStep = 250;

        private const uint FileAttributeDirectory = 0x00000010;
        private const uint FileAttributeReparsePoint = 0x00000400;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WIN32_FIND_DATA
        {
            public uint dwFileAttributes;
            public uint ftCreationTimeLow;
            public uint ftCreationTimeHigh;
            public uint ftLastAccessTimeLow;
            public uint ftLastAccessTimeHigh;
            public uint ftLastWriteTimeLow;
            public uint ftLastWriteTimeHigh;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint dwReserved0;
            public uint dwReserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string cFileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
            public string cAlternateFileName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstFileExW(
            string lpFileName,
            int fInfoLevelId,
            out WIN32_FIND_DATA lpFindFileData,
            int fSearchOp,
            IntPtr lpSearchFilter,
            int dwAdditionalFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool FindNextFileW(IntPtr hFindFile, out WIN32_FIND_DATA lpFindFileData);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FindClose(IntPtr hFindFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string lpFileName);

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

        public static QuickScanResult Scan(string rootPath, string[] skipDirNames, Action<int, int, int> progress)
        {
            QuickScanResult result = new QuickScanResult();
            result.RootLabel = "Unknown";

            HashSet<string> skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (skipDirNames != null)
            {
                for (int index = 0; index < skipDirNames.Length; index++)
                {
                    string skipName = skipDirNames[index];
                    if (skipName == null) continue;
                    skipName = skipName.Trim();
                    if (skipName.Length > 0) skip.Add(skipName);
                }
            }

            Stopwatch watch = Stopwatch.StartNew();
            string rootWin32 = ToWin32Path(rootPath);
            uint rootAttributes = GetFileAttributesW(rootWin32);
            bool rootIsDirectory = ((rootAttributes & FileAttributeDirectory) != 0);
            bool rootIsReparse = ((rootAttributes & FileAttributeReparsePoint) != 0);

            ProcessItem(result, rootWin32, NormalizeForOutput(rootWin32), rootIsDirectory, true);
            if (result.RootLabel == null) result.RootLabel = "Unknown";

            Stack<string> directories = new Stack<string>();
            if (rootIsDirectory && !rootIsReparse) directories.Push(rootWin32);

            int lastProgressScanned = 0;
            long lastProgressMilliseconds = 0;

            while (directories.Count > 0)
            {
                string directory = directories.Pop();
                bool directoryHasTrailingBackslash = directory.EndsWith("\\", StringComparison.Ordinal);
                string pattern = directoryHasTrailingBackslash ? directory + "*" : directory + "\\*";
                WIN32_FIND_DATA findData;
                // fInfoLevelId 1 = FindExInfoBasic (skips short-name lookup);
                // dwAdditionalFlags 2 = FIND_FIRST_EX_LARGE_FETCH (faster large dirs).
                IntPtr findHandle = FindFirstFileExW(pattern, 1, out findData, 0, IntPtr.Zero, 2);
                if (findHandle == new IntPtr(-1))
                {
                    int enumerationError = Marshal.GetLastWin32Error();
                    AddError(result, NormalizeForOutput(directory), "enumerate failed: " + DescribeWin32(enumerationError));
                }
                else
                {
                    try
                    {
                        bool hasMore = true;
                        while (hasMore)
                        {
                            string fileName = findData.cFileName;
                            if (fileName != null && fileName.Length > 0 && fileName != "." && fileName != "..")
                            {
                                bool isDirectory = ((findData.dwFileAttributes & FileAttributeDirectory) != 0);
                                bool isReparse = ((findData.dwFileAttributes & FileAttributeReparsePoint) != 0);
                                bool skipThis = (isDirectory && skip.Contains(fileName));
                                if (!skipThis)
                                {
                                    string childWin32 = directoryHasTrailingBackslash ? directory + fileName : directory + "\\" + fileName;
                                    ProcessItem(result, childWin32, NormalizeForOutput(childWin32), isDirectory, false);
                                    if (isDirectory && !isReparse) directories.Push(childWin32);
                                }
                            }
                            hasMore = FindNextFileW(findHandle, out findData);
                        }
                    }
                    finally
                    {
                        FindClose(findHandle);
                    }
                }

                long elapsed = watch.ElapsedMilliseconds;
                if (progress != null && ((result.Scanned - lastProgressScanned) >= ProgressItemStep || (elapsed - lastProgressMilliseconds) >= ProgressMillisecondStep))
                {
                    progress(result.Scanned, result.Hits, result.Errors.Count);
                    lastProgressScanned = result.Scanned;
                    lastProgressMilliseconds = elapsed;
                }
            }

            watch.Stop();
            result.ScanMs = watch.ElapsedMilliseconds;
            return result;
        }

        private static void ProcessItem(QuickScanResult result, string win32Path, string outputPath, bool isDirectory, bool isRoot)
        {
            int errorCode = 0;
            string sddl = GetLabelSddl(win32Path, out errorCode);
            if (sddl == null)
            {
                result.Scanned = result.Scanned + 1;
                AddError(result, outputPath, DescribeWin32(errorCode));
                if (isRoot) result.RootLabel = "Unknown";
                return;
            }
            bool explicitLabel = false;
            bool inheritedLabel = false;
            string level = ParseLabelSddl(sddl, out explicitLabel, out inheritedLabel);
            if (isRoot) result.RootLabel = level;
            result.Scanned = result.Scanned + 1;
            if (level != "Low") return;
            result.Hits = result.Hits + 1;
            if (explicitLabel) result.ExplicitCount = result.ExplicitCount + 1;
            else result.InheritedCount = result.InheritedCount + 1;
            if (!explicitLabel) return;
            if (result.ExplicitHits.Count < MaxExplicitHits)
            {
                QuickScanHit hit = new QuickScanHit();
                hit.Path = outputPath;
                hit.Kind = isDirectory ? "dir" : "file";
                hit.Explicit = true;
                hit.Inherited = false;
                hit.Sddl = sddl;
                result.ExplicitHits.Add(hit);
            }
            else
            {
                result.Truncated = true;
            }
        }

        private static string GetLabelSddl(string path, out int errorCode)
        {
            errorCode = 0;
            IntPtr securityDescriptor;
            uint callResult = GetNamedSecurityInfoW(
                path,
                SeFileObject,
                LabelSecurityInformation,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                out securityDescriptor);
            if (callResult != 0)
            {
                errorCode = unchecked((int)callResult);
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

        private static string ParseLabelSddl(string sddl, out bool explicitLabel, out bool inheritedLabel)
        {
            explicitLabel = false;
            inheritedLabel = false;
            if (sddl == null || sddl.Length == 0) return "None";
            string explicitLevel = null;
            string inheritedLevel = null;
            int index = 0;
            while (index < sddl.Length)
            {
                int open = sddl.IndexOf('(', index);
                if (open < 0) break;
                int close = sddl.IndexOf(')', open + 1);
                if (close < 0) break;
                string ace = sddl.Substring(open + 1, close - open - 1);
                if (ace.StartsWith("ML;", StringComparison.Ordinal))
                {
                    string[] parts = ace.Split(';');
                    if (parts.Length >= 6)
                    {
                        string aceFlags = parts[1];
                        string aceSid = parts[5];
                        bool inheritedAce = (aceFlags.IndexOf("ID", StringComparison.Ordinal) >= 0);
                        string level = LevelFromSid(aceSid);
                        if (inheritedAce)
                        {
                            if (inheritedLevel == null) inheritedLevel = level;
                        }
                        else
                        {
                            if (explicitLevel == null) explicitLevel = level;
                        }
                    }
                }
                index = close + 1;
            }
            if (explicitLevel != null)
            {
                explicitLabel = true;
                inheritedLabel = false;
                return explicitLevel;
            }
            if (inheritedLevel != null)
            {
                inheritedLabel = true;
                return inheritedLevel;
            }
            return "None";
        }

        private static string LevelFromSid(string sid)
        {
            if (sid == null) return "None";
            if (sid == "LW") return "Low";
            if (sid == "ME") return "Medium";
            if (sid == "HI") return "High";
            if (sid == "SI") return "System";
            if (sid.StartsWith("S-1-16-", StringComparison.Ordinal))
            {
                int rid = 0;
                if (int.TryParse(sid.Substring(7), out rid))
                {
                    switch (rid)
                    {
                        case 0: return "Untrusted";
                        case 4096: return "Low";
                        case 8192: return "Medium";
                        case 12288: return "High";
                        case 16384: return "System";
                        case 20480: return "Protected";
                        default: return "S-1-16-" + rid.ToString();
                    }
                }
            }
            return sid;
        }

        private static void AddError(QuickScanResult result, string path, string message)
        {
            if (result.Errors.Count < MaxErrors)
            {
                QuickScanError item = new QuickScanError();
                item.Path = path;
                item.Message = message;
                result.Errors.Add(item);
            }
            else
            {
                result.Truncated = true;
            }
        }

        private static string DescribeWin32(int errorCode)
        {
            try
            {
                string text = new Win32Exception(errorCode).Message;
                return text + " (Win32 " + errorCode.ToString() + ")";
            }
            catch
            {
                return "Win32 " + errorCode.ToString();
            }
        }

        private static string ToWin32Path(string path)
        {
            if (path == null) return path;
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
            if (path.Length == 3 && path[1] == ':' && path[2] == '\\') return path;
            return @"\\?\" + path;
        }

        private static string NormalizeForOutput(string win32Path)
        {
            if (win32Path == null) return null;
            if (win32Path.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + win32Path.Substring(8);
            if (win32Path.StartsWith(@"\\?\", StringComparison.Ordinal)) return win32Path.Substring(4);
            return win32Path;
        }
    }
}
'@

function Ensure-QuickScannerType {
    if (-not ([System.Management.Automation.PSTypeName]'DshIntegrity.QuickScanner').Type) {
        Add-Type -TypeDefinition $script:QuickScannerTypeCode -Language CSharp -ErrorAction Stop | Out-Null
    }
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

function Get-LabelLevelFast {
    param([string]$Win32Path)
    $errorCode = 0
    $level = $null
    try {
        $level = [DshIntegrity.Native]::GetLabelLevel($Win32Path, [ref]$errorCode)
    } catch {
        return @{ ok = $false; level = 'Unknown'; errorCode = -1; message = $_.Exception.Message }
    }
    if ($errorCode -ne 0) {
        return @{ ok = $false; level = 'Unknown'; errorCode = $errorCode; message = (Get-Win32Message $errorCode) }
    }
    if ($null -eq $level) { $level = 'Unknown' }
    return @{ ok = $true; level = [string]$level; errorCode = 0; message = '' }
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
    $isDirectory = ($Kind -eq 'dir')

    # Fast path 1: in-process SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION).
    # No icacls process is spawned for the common case.
    $nativeSetCode = -1
    try {
        if ($TargetLevel -eq 'Medium') {
            $nativeSetCode = [DshIntegrity.Native]::SetLabelToMedium($Win32Path, $isDirectory)
        } else {
            $sddlLevel = ConvertTo-SddlLevelAbbreviation $TargetLevel
            if ($isDirectory) {
                $sddl = 'S:(ML;OICI;NW;;;' + $sddlLevel + ')'
            } else {
                $sddl = 'S:(ML;;NW;;;' + $sddlLevel + ')'
            }
            $nativeSetCode = [DshIntegrity.Native]::SetLabel($Win32Path, $sddl)
        }
    } catch {
        $nativeSetCode = -1
    }
    if ($nativeSetCode -eq 0) {
        return @{ ok = $true; method = 'native'; output = ''; message = ''; icaclsExitCode = 0 }
    }

    # Fast path 2: Access denied -> in-process temporary WRITE_OWNER DACL grant.
    # The DACL is saved, the grant/restore happens via SetNamedSecurityInfoW and the
    # restored DACL is compared byte-for-byte with the original SDDL.
    $grantDiagnostics = $null
    $failureMessage = 'in-process SetNamedSecurityInfoW failed: Win32 ' + $nativeSetCode + ' (' + (Get-Win32Message $nativeSetCode) + ')'
    if ($TargetLevel -eq 'Medium' -and $nativeSetCode -eq 5) {
        $ownerInfo = Get-IntegrityObjectOwnerSid -Win32Path $Win32Path
        $currentSid = Get-CurrentUserSid
        $guidance = 'guidance: run the repair as the object owner or with administrator rights'
        if (-not $ownerInfo.ok) {
            $failureMessage = 'access denied (Win32 5); the object owner could not be read (' + $ownerInfo.message + '); ' + $guidance
        } elseif ([string]::IsNullOrEmpty($currentSid)) {
            $failureMessage = 'access denied (Win32 5); the current user SID is unknown; ' + $guidance
        } elseif (-not ([string]$ownerInfo.sid).Equals($currentSid, [System.StringComparison]::OrdinalIgnoreCase)) {
            $failureMessage = 'access denied (Win32 5); object owner ' + [string]$ownerInfo.sid + ' is not the current user ' + $currentSid + '; ' + $guidance
        } else {
            try {
                $grantDiagnostics = [DshIntegrity.Native]::SetLabelToMediumWithTemporaryGrant($Win32Path, $isDirectory, $currentSid)
            } catch {
                $grantDiagnostics = $null
                $failureMessage = 'access denied (Win32 5); in-process temporary grant threw: ' + $_.Exception.Message + '; ' + $guidance
            }
            if ($null -ne $grantDiagnostics) {
                if ($grantDiagnostics.LabelCode -eq 0 -and $grantDiagnostics.DaclRestored) {
                    return @{
                        ok     = $true
                        method = 'grant'
                        output = ''
                        message = 'access denied; in-process temporary WRITE_OWNER grant used and DACL restored'
                        icaclsExitCode = 0
                    }
                }
                $failureMessage = 'access denied (Win32 5); in-process temporary grant failed'
                if ($grantDiagnostics.Message) {
                    $failureMessage = $failureMessage + ': ' + [string]$grantDiagnostics.Message
                }
                if (-not $grantDiagnostics.DaclRestored) {
                    $failureMessage = $failureMessage + '; the DACL was not restored byte-for-byte (before=' + [string]$grantDiagnostics.DaclBefore + ' after=' + [string]$grantDiagnostics.DaclAfter + '); guidance: inspect and restore the ACL manually'
                } else {
                    $failureMessage = $failureMessage + '; ' + $guidance
                }
            }
        }
    }

    # Legacy fallback: icacls. Only reached for unusual/non-Medium failures; it is
    # also what produces the human readable error text in the failed log.
    $levelSpecification = $TargetLevel
    if ($isDirectory) { $levelSpecification = '(OI)(CI)' + $TargetLevel }
    $toolPath = Get-IcaclsToolPath -NormalPath $NormalPath -Win32Path $Win32Path
    $arguments = (Quote-ProcessArgument $toolPath) + ' /setintegritylevel ' + (Quote-ProcessArgument $levelSpecification)
    $call = Invoke-IcaclsProcess -Executable $script:IcaclsExecutable -ArgumentString $arguments
    if ($call.exitCode -eq 0) {
        return @{ ok = $true; method = 'icacls'; output = $call.output; message = ''; icaclsExitCode = 0 }
    }

    $combinedOutput = $call.output
    if ($call.exitCode -eq 5) {
        $legacyGrant = Set-IntegrityLevelWithOwnerGrant -NormalPath $NormalPath -Win32Path $Win32Path -Kind $Kind -TargetLevel $TargetLevel -OriginalOutput $call.output
        if ($legacyGrant.ok) { return $legacyGrant }
        if ($legacyGrant.message) { $failureMessage = $failureMessage + '; ' + [string]$legacyGrant.message }
        $combinedOutput = [string]$legacyGrant.output
    }

    return @{
        ok             = $false
        method         = 'native+icacls'
        output         = $combinedOutput
        message        = $failureMessage
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
    $before = Get-LabelLevelFast -Win32Path $Hit.win32Path
    if ($before.ok -and $before.level -ne 'Low') {
        return @{ status = 'already' }
    }
    $preReadMessage = ''
    if (-not $before.ok) { $preReadMessage = 'pre-read failed: ' + $before.message }

    $setResult = Set-IntegrityLevelOnPath -NormalPath $Hit.path -Win32Path $Hit.win32Path -Kind $Hit.kind -TargetLevel $TargetLevel
    $after = Get-LabelLevelFast -Win32Path $Hit.win32Path
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
        [string[]]$ExcludePaths = @(),
        [int]$MaxCollectCount = 0
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
                if ($null -ne $HitCollector) {
                    if ($MaxCollectCount -le 0 -or $HitCollector.Count -lt $MaxCollectCount) {
                        [void]$HitCollector.Add($hit)
                    }
                }
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
# Scan report writer: a complete machine readable result file written directly by
# the engine, so the Host can export it without re-serializing its in-memory items.
# ---------------------------------------------------------------------------
function Resolve-DataDirectory {
    $dataDirectory = $DataDir
    if ([string]::IsNullOrEmpty($dataDirectory)) {
        $dataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-file-integrity-check'
    }
    try {
        $dataDirectory = [System.IO.Path]::GetFullPath($dataDirectory)
    } catch { }
    return $dataDirectory
}

function Get-RelativeReportPath {
    param([string]$RootNormal, [string]$ItemNormal)
    if ([string]::IsNullOrEmpty($RootNormal) -or [string]::IsNullOrEmpty($ItemNormal)) { return $ItemNormal }
    $rootText = $RootNormal.TrimEnd('\')
    if ($rootText.Length -eq 0) { return $ItemNormal }
    $rootLower = $rootText.ToLowerInvariant()
    $itemLower = $ItemNormal.ToLowerInvariant()
    if ($itemLower -eq $rootLower) { return '.' }
    if ($itemLower.StartsWith($rootLower + '\')) { return $ItemNormal.Substring($rootText.Length + 1) }
    return $ItemNormal
}

function Write-ScanReport {
    param(
        [string]$Depth,
        [string]$EngineName,
        [string]$RootPath,
        [string]$RootLabel,
        [int]$Scanned,
        [int]$Hits,
        [int]$ExplicitCount,
        [int]$InheritedCount,
        [bool]$Truncated,
        $Items,
        $ErrorList,
        [long]$ScanMs
    )
    $reportPath = $null
    try {
        $dataDirectory = Resolve-DataDirectory
        $reportDirectory = Join-Path $dataDirectory 'reports'
        if (-not [System.IO.Directory]::Exists($reportDirectory)) {
            [System.IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
        }
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
        $reportPath = Join-Path $reportDirectory ('scan-' + $stamp + '.json')

        $reportItems = New-Object System.Collections.ArrayList
        $itemCount = 0
        if ($null -ne $Items) {
            foreach ($item in $Items) {
                $itemPath = [string]$item.path
                [void]$reportItems.Add([ordered]@{
                        path         = $itemPath
                        relativePath = (Get-RelativeReportPath -RootNormal $RootPath -ItemNormal $itemPath)
                        kind         = [string]$item.kind
                        explicit     = [bool]$item.explicit
                        label        = 'Low'
                        sddl         = [string]$item.sddl
                    })
                $itemCount = $itemCount + 1
            }
        }
        $expectedItemCount = $Hits
        if ($Depth -eq 'quick') { $expectedItemCount = $ExplicitCount }
        $itemsTruncated = ([bool]$Truncated) -or ($expectedItemCount -gt $itemCount)
        $itemsScope = 'all'
        $note = 'deep scan: every Low object is listed in items'
        if ($Depth -eq 'quick') {
            $itemsScope = 'explicit'
            $note = 'quick scan: inherited Low objects are counted (inheritedCount) but not listed in items'
        }
        $document = [ordered]@{
            version        = $script:EngineVersion
            createdAt      = (Get-Date).ToString('o')
            mode           = 'scan'
            depth          = $Depth
            engine         = $EngineName
            root           = $RootPath
            rootLabel      = $RootLabel
            scanned        = $Scanned
            hits           = $Hits
            explicitCount  = $ExplicitCount
            inheritedCount = $InheritedCount
            truncated      = [bool]$itemsTruncated
            scanMs         = $ScanMs
            itemsScope     = $itemsScope
            note           = $note
            items          = $reportItems
            errors         = $ErrorList
        }
        Write-TextFileNoBom -Path $reportPath -Text (ConvertTo-JsonValue $document)
        return $reportPath
    } catch {
        $message = $_.Exception.Message
        $message = $message -replace "`r?`n", ' '
        Write-Event -Fields ([ordered]@{
                type    = 'error'
                path    = [string]$reportPath
                message = ('scan report write failed: ' + $message)
            })
        return $null
    }
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
    if ($ScanDepth -eq 'quick') {
        return (Invoke-QuickScanMode)
    }
    return (Invoke-DeepScanMode)
}

function Invoke-DeepScanMode {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $rootCheck = Test-RootArgument
    if (-not $rootCheck.ok) { return 3 }

    # Collect all hits for the report file (capped at MaxReportItems to bound memory;
    # the report then carries truncated=true).
    $deepHits = New-Object System.Collections.ArrayList
    $scan = Invoke-Traversal -RootNormal $rootCheck.rootNormal -SkipDirNames $script:SkipDirList -StreamHits $true -HitCollector $deepHits -ProgressPhase 'enumerate' -MaxCollectCount $script:MaxReportItems

    $convertedErrors = ConvertTo-ResultErrors -ErrorList $scan.errors
    $truncated = ([bool]$scan.truncated) -or ([bool]$convertedErrors.truncated)

    $reportPath = Write-ScanReport -Depth 'deep' -EngineName 'powershell' -RootPath $rootCheck.rootNormal -RootLabel $scan.rootLabel -Scanned ([int]$scan.scanned) -Hits ([int]$scan.hits) -ExplicitCount ([int]$scan.explicitCount) -InheritedCount ([int]$scan.inheritedCount) -Truncated ([bool]$truncated) -Items $deepHits -ErrorList $convertedErrors.list -ScanMs ([long]$stopwatch.ElapsedMilliseconds)

    Write-Event -Fields ([ordered]@{
            type           = 'result'
            mode           = 'scan'
            depth          = 'deep'
            engine         = 'powershell'
            root           = $rootCheck.rootNormal
            rootLabel      = $scan.rootLabel
            scanned        = $scan.scanned
            hits           = $scan.hits
            explicitCount  = $scan.explicitCount
            inheritedCount = $scan.inheritedCount
            errors         = $convertedErrors.list
            truncated      = [bool]$truncated
            reportPath     = $reportPath
            engineVersion  = $script:EngineVersion
            durationMs     = [int]$stopwatch.ElapsedMilliseconds
        })

    if ($scan.hits -gt 0) { return 2 }
    return 0
}

function Invoke-QuickScanMode {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $rootCheck = Test-RootArgument
    if (-not $rootCheck.ok) { return 3 }

    try {
        Ensure-QuickScannerType
    } catch {
        Write-Fatal -Code 'scanner-init-failed' -Message ('Could not compile the embedded C# quick scanner: ' + $_.Exception.Message)
        return 3
    }

    # The C# scanner calls this delegate every ~2000 items or ~250 ms; each call
    # becomes one progress JSON line (throttled native-side, so the callback cost
    # is negligible).
    $progressCallback = [System.Action[int, int, int]] {
        param($scanned, $hitCount, $errorCount)
        Write-ProgressEvent -Phase 'enumerate' -Scanned $scanned -Total $null -Hits $hitCount
    }

    try {
        $scan = [DshIntegrity.QuickScanner]::Scan($rootCheck.rootNormal, $script:SkipDirList, $progressCallback)
    } catch {
        Write-Fatal -Code 'scan-failed' -Message $_.Exception.Message
        return 3
    }

    # quick depth: only explicit Low objects are streamed as hit lines.
    foreach ($hit in $scan.ExplicitHits) {
        Write-Event -Fields ([ordered]@{
                type      = 'hit'
                path      = [string]$hit.Path
                kind      = [string]$hit.Kind
                explicit  = $true
                label     = 'Low'
                inherited = $false
                sddl      = [string]$hit.Sddl
            })
    }

    Write-ProgressEvent -Phase 'enumerate' -Scanned ([int]$scan.Scanned) -Total $null -Hits ([int]$scan.Hits)

    $convertedErrors = ConvertTo-ResultErrors -ErrorList $scan.Errors
    $truncated = ([bool]$scan.Truncated) -or ([bool]$convertedErrors.truncated)

    $reportPath = Write-ScanReport -Depth 'quick' -EngineName 'csharp' -RootPath $rootCheck.rootNormal -RootLabel ([string]$scan.RootLabel) -Scanned ([int]$scan.Scanned) -Hits ([int]$scan.Hits) -ExplicitCount ([int]$scan.ExplicitCount) -InheritedCount ([int]$scan.InheritedCount) -Truncated ([bool]$truncated) -Items $scan.ExplicitHits -ErrorList $convertedErrors.list -ScanMs ([long]$scan.ScanMs)

    Write-Event -Fields ([ordered]@{
            type           = 'result'
            mode           = 'scan'
            depth          = 'quick'
            engine         = 'csharp'
            root           = $rootCheck.rootNormal
            rootLabel      = [string]$scan.RootLabel
            scanned        = [int]$scan.Scanned
            hits           = [int]$scan.Hits
            explicitCount  = [int]$scan.ExplicitCount
            inheritedCount = [int]$scan.InheritedCount
            errors         = $convertedErrors.list
            truncated      = [bool]$truncated
            scanMs         = [long]$scan.ScanMs
            reportPath     = $reportPath
            engineVersion  = $script:EngineVersion
            durationMs     = [int]$stopwatch.ElapsedMilliseconds
        })

    if ([int]$scan.Hits -gt 0) { return 2 }
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
    $methods = @{ icacls = 0; pinvoke = 0; grant = 0; native = 0 }

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
        $info = Get-LabelLevelFast -Win32Path $hit.win32Path
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
            methods        = ([ordered]@{ icacls = $methods['icacls']; pinvoke = $methods['pinvoke']; grant = $methods['grant']; native = $methods['native'] })
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
