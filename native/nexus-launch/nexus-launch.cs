// nexus-launch: starts one command inside the NEXUS containment and relays its exit code.
//
// NEXUS never runs project code itself and never lets an agent's shell run it bare: the command is handed to
// this program in a spec file, and this program is the only place where the containment is made. It creates a
// job object (the whole process tree dies with the job; no child can leave it) and a token with every privilege
// removed and low integrity, starts the command suspended, puts it in the job, and only then lets it run. If
// any step fails nothing runs: there is no path from here to an uncontained start.
//
// Two profiles. RESTRICTED runs the command as the user, at low integrity: it can write only where a directory
// was labeled for it and cannot read what was labeled protected; it still has the user's network, credential
// vault and unprotected files. ISOLATED runs it as the machine's sandbox account (created once, elevated, by
// native/sandbox-setup), also at low integrity: that account has no access to the user's profile, vault or
// keys, and Windows Firewall lets none of its traffic out, so its only way to the network is the loopback
// proxy NEXUS gives it. ISOLATED is made in two steps: this program, as the user, logs the account on and
// starts a copy of itself as that account inside the job; the copy lowers its own token and starts the command.
//
// Build (C# 5, the compiler that ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /platform:x64 /target:exe
//       /r:System.Security.dll /out:nexus-launch.exe nexus-launch.cs
//
// Exit codes: the command's own, or 120..127 for the launcher's failures (125: the containment could not be made).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
[StructLayout(LayoutKind.Sequential)]
struct TRUSTEE { public IntPtr pMultipleTrustee; public int MultipleTrusteeOperation; public int TrusteeForm; public int TrusteeType; public IntPtr ptstrName; }
[StructLayout(LayoutKind.Sequential)]
struct EXPLICIT_ACCESS { public uint grfAccessPermissions; public int grfAccessMode; public uint grfInheritance; public TRUSTEE Trustee; }
[StructLayout(LayoutKind.Sequential)]
struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
[StructLayout(LayoutKind.Sequential)]
struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
[StructLayout(LayoutKind.Sequential)]
struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
[StructLayout(LayoutKind.Sequential)]
struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
[StructLayout(LayoutKind.Sequential)]
struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

static class N {
    const string K = "kernel32.dll"; const string A = "advapi32.dll";
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
    [DllImport(A, CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr s);
    [DllImport(A)] public static extern bool EqualSid(IntPtr a, IntPtr b);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capabilitySids, out uint capabilityCount);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder path, uint length, uint flags);
    [DllImport(K)] public static extern IntPtr GetCurrentProcess();
    [DllImport(K)] public static extern uint SetErrorMode(uint m);
    [DllImport(K)] public static extern IntPtr GetStdHandle(int n);
    [DllImport(K, SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr a, string name);
    [DllImport(K, SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport(K, SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, out int ret);
    [DllImport(K, SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport(K, SetLastError = true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool res);
    [DllImport(K, SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport(K, SetLastError = true)] public static extern bool TerminateProcess(IntPtr p, uint code);
    [DllImport(K, SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
    [DllImport(K, SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport(K, SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string f, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport(K, SetLastError = true)] public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessAsUserW(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport(A, SetLastError = true)] public static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
    [DllImport(A, SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr t, uint acc, IntPtr sa, int impLevel, int type, out IntPtr nt);
    [DllImport(A, SetLastError = true)] public static extern bool CreateRestrictedToken(IntPtr t, uint flags, uint nDis, IntPtr dis, uint nPriv, IntPtr priv, uint nRes, IntPtr res, out IntPtr nt);
    [DllImport(A, SetLastError = true)] public static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int ret);
    [DllImport(A, SetLastError = true)] public static extern bool SetTokenInformation(IntPtr t, int cls, IntPtr buf, int len);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
    [DllImport(A)] public static extern uint GetLengthSid(IntPtr sid);
    [DllImport(A)] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);
    [DllImport(A)] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, out uint sz);
    [DllImport(A, SetLastError = true)] public static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport(K)] public static extern IntPtr LocalFree(IntPtr p);
    [DllImport(A, SetLastError = true)] public static extern uint SetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport(A, SetLastError = true)] public static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport(A, SetLastError = true)] public static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr sd);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint SetEntriesInAclW(uint count, ref EXPLICIT_ACCESS entries, IntPtr oldAcl, out IntPtr newAcl);
    [DllImport(K, SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport(K, SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport(K)] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessAsUserW")] public static extern bool CreateProcessAsUserExW(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WaitNamedPipeW(string name, uint ms);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags, string app, StringBuilder cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
}

class Fail : Exception {
    public int Code;
    public Fail(int code, string message) : base(message) { Code = code; }
}

class Spec {
    public string Profile = "";
    public string Cwd = null;
    public string Command = null;
    public List<string> Env = new List<string>();
    public uint MaxProcesses = 256;
    public ulong MaxJobMemory = 0;
    public uint TimeoutMs = 0;
    public uint UiLimits = 0xFF;
    public bool Window = false;
    // A desktop made for the command: its windows are on no screen. Letters, digits and '-' only.
    public string Desktop = null;
    public string Report = null;
    // ISOLATED only: the DPAPI blob with the sandbox account, the launcher copy that account can run, and the
    // directory (in the sandbox root) where the inner spec is written.
    public string Credential = null;
    public string Stage2 = null;
    public string Stage2Dir = null;
    // ISOLATED: the SID of the sandbox account NEXUS verified. STAGE2: the SID this process must be running as.
    public string AccountSid = null;
    public string ExpectSid = null;
    // ISOLATED and STAGE2: the name of the AppContainer the command is started in. It holds one capability, of
    // NEXUS's own making and of the same name, which Windows gives no meaning: it is only what the access lists
    // of the sandbox's folders name. It holds none of Windows' capabilities, so Windows looks up no name for it,
    // shows it nothing of the machine's name cache and lets none of its packets out.
    public string AppContainer = null;
    // 0.9: further capabilities of NEXUS's own, by name, that the command holds beside the one of the AppContainer's
    // name. The first is the session's: the directories only this session writes are opened to it and to nothing
    // else, and the command's own process, threads and whatever it creates without saying who may open it are
    // open to holders of it only. A second may be the project's (its package cache). None is one of Windows'.
    public List<string> Capabilities = new List<string>();
    // 0.9.1, PRESENT only: the command gets this launcher's own environment (the agent's shell's), not a list.
    public bool InheritEnv = false;
}

static class Program {
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint JOB_KILL_ON_CLOSE = 0x2000, JOB_ACTIVE_PROCESS = 0x8, JOB_MEMORY = 0x200, JOB_DIE_ON_UNHANDLED = 0x400;
    const int EXIT_USAGE = 120, EXIT_SPEC = 121, EXIT_CONTAINMENT = 125, EXIT_START = 126, EXIT_TIMEOUT = 124;

    static void Err(string s) {
        try { Console.Error.WriteLine("nexus-launch: " + s); } catch (Exception) { }
    }

    static string B64(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }

    static Spec ReadSpec(string path) {
        Spec spec = new Spec();
        string[] lines;
        try { lines = File.ReadAllLines(path, Encoding.UTF8); } catch (Exception e) { throw new Fail(EXIT_SPEC, "the spec cannot be read: " + e.Message); }
        bool version = false;
        foreach (string raw in lines) {
            string line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) throw new Fail(EXIT_SPEC, "a spec line has no '='");
            string key = line.Substring(0, eq); string value = line.Substring(eq + 1);
            try {
                if (key == "version") { if (value != "1") throw new Fail(EXIT_SPEC, "unknown spec version"); version = true; }
                else if (key == "profile") spec.Profile = value;
                else if (key == "cwd") spec.Cwd = B64(value);
                else if (key == "command") spec.Command = B64(value);
                else if (key == "env") spec.Env.Add(B64(value));
                else if (key == "max-processes") spec.MaxProcesses = uint.Parse(value);
                else if (key == "max-job-memory") spec.MaxJobMemory = ulong.Parse(value);
                else if (key == "timeout-ms") spec.TimeoutMs = uint.Parse(value);
                else if (key == "ui-limits") spec.UiLimits = uint.Parse(value);
                else if (key == "window") spec.Window = value == "1";
                else if (key == "desktop") spec.Desktop = value;
                else if (key == "report") spec.Report = B64(value);
                else if (key == "credential") spec.Credential = B64(value);
                else if (key == "stage2") spec.Stage2 = B64(value);
                else if (key == "stage2-dir") spec.Stage2Dir = B64(value);
                else if (key == "account-sid") spec.AccountSid = value;
                else if (key == "expect-sid") spec.ExpectSid = value;
                else if (key == "appcontainer") spec.AppContainer = value;
                else if (key == "capability") spec.Capabilities.Add(value);
                else if (key == "inherit-env") spec.InheritEnv = value == "1";
                // An unknown key is refused: a spec this launcher does not fully understand is not run.
                else throw new Fail(EXIT_SPEC, "unknown spec key: " + key);
            } catch (Fail) { throw; } catch (Exception) { throw new Fail(EXIT_SPEC, "bad value for " + key); }
        }
        if (!version) throw new Fail(EXIT_SPEC, "the spec has no version");
        if (spec.Profile != "ISOLATED" && spec.Profile != "RESTRICTED" && spec.Profile != "STAGE2" && spec.Profile != "PRESENT") throw new Fail(EXIT_SPEC, "the spec names no known profile");
        // 0.9.1: PRESENT is not a containment. It is the user's own command, as the user, on a desktop of its own so
        // that nothing it shows reaches the user's screen or takes the user's focus, in a job that ends it with this
        // launcher. Nothing of the containment profiles may be asked of it, and nothing of it of them.
        if (spec.Profile == "PRESENT" && (spec.Credential != null || spec.Stage2 != null || spec.Stage2Dir != null || spec.AccountSid != null || spec.ExpectSid != null || spec.AppContainer != null || spec.Capabilities.Count > 0)) throw new Fail(EXIT_SPEC, "the PRESENT profile is the user's own: it names no account, AppContainer or capability");
        if (spec.InheritEnv && spec.Profile != "PRESENT") throw new Fail(EXIT_SPEC, "only the PRESENT profile inherits the launcher's environment");
        if (spec.Profile == "ISOLATED" && (string.IsNullOrEmpty(spec.Credential) || string.IsNullOrEmpty(spec.Stage2) || string.IsNullOrEmpty(spec.Stage2Dir))) throw new Fail(EXIT_SPEC, "the ISOLATED profile needs the sandbox account's credential and launcher");
        if (string.IsNullOrEmpty(spec.Command)) throw new Fail(EXIT_SPEC, "the spec has no command");
        if (string.IsNullOrEmpty(spec.Cwd) || !Directory.Exists(spec.Cwd)) throw new Fail(EXIT_SPEC, "the working directory does not exist");
        if (spec.MaxProcesses < 1 || spec.MaxProcesses > 4096) throw new Fail(EXIT_SPEC, "max-processes out of range");
        foreach (string sid in new string[] { spec.AccountSid, spec.ExpectSid }) {
            if (sid == null) continue;
            if (sid.Length < 8 || sid.Length > 120 || !sid.StartsWith("S-1-")) throw new Fail(EXIT_SPEC, "bad SID");
            foreach (char c in sid.Substring(4)) if (!((c >= '0' && c <= '9') || c == '-')) throw new Fail(EXIT_SPEC, "bad SID");
        }
        if (spec.AppContainer != null) {
            if (spec.Profile == "RESTRICTED") throw new Fail(EXIT_SPEC, "an AppContainer is part of the ISOLATED profile only");
            if (spec.AppContainer.Length < 1 || spec.AppContainer.Length > 64) throw new Fail(EXIT_SPEC, "bad AppContainer name");
            foreach (char c in spec.AppContainer) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) throw new Fail(EXIT_SPEC, "bad AppContainer name");
        }
        // 0.9: the isolated profile is an AppContainer, always. A spec that leaves it out is not run as the account
        // without one.
        if ((spec.Profile == "ISOLATED" || spec.Profile == "STAGE2") && spec.AppContainer == null) throw new Fail(EXIT_SPEC, "the ISOLATED profile names its AppContainer");
        if (spec.Capabilities.Count > 0 && spec.AppContainer == null) throw new Fail(EXIT_SPEC, "a capability is held by an AppContainer only");
        if (spec.Capabilities.Count > 3) throw new Fail(EXIT_SPEC, "too many capabilities");
        foreach (string name in spec.Capabilities) {
            // Names of NEXUS's own making only: Windows derives the SID of one of its own capabilities (the network,
            // the libraries) from that capability's name, and none of those is ever given.
            if (name.Length < 14 || name.Length > 64 || !name.StartsWith("NexusSandbox.") || name == spec.AppContainer) throw new Fail(EXIT_SPEC, "bad capability name");
            foreach (char c in name) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) throw new Fail(EXIT_SPEC, "bad capability name");
        }
        if (spec.Desktop != null) {
            if (spec.Desktop.Length < 1 || spec.Desktop.Length > 40) throw new Fail(EXIT_SPEC, "bad desktop name");
            foreach (char c in spec.Desktop) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) throw new Fail(EXIT_SPEC, "bad desktop name");
        }
        return spec;
    }

    static IntPtr Sid(string s) {
        IntPtr p; if (!N.ConvertStringSidToSidW(s, out p)) throw new Fail(EXIT_CONTAINMENT, "ConvertStringSidToSid failed: " + Marshal.GetLastWin32Error());
        return p;
    }

    /** The integrity level of a token as its RID (0x1000 low, 0x2000 medium, 0x3000 high). */
    static uint IntegrityOf(IntPtr token) {
        int need; N.GetTokenInformation(token, 25, IntPtr.Zero, 0, out need);
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
            if (!N.GetTokenInformation(token, 25, buf, need, out need)) throw new Fail(EXIT_CONTAINMENT, "the integrity level of the token cannot be read: " + Marshal.GetLastWin32Error());
            IntPtr sid = Marshal.ReadIntPtr(buf);
            byte count = Marshal.ReadByte(N.GetSidSubAuthorityCount(sid));
            return (uint)Marshal.ReadInt32(N.GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally { Marshal.FreeHGlobal(buf); }
    }

    /**
     * 0.9.1, PRESENT: this process's own rights, unchanged: a restricted copy of its token that restricts nothing
     * (Windows lets a process start another with such a copy, which it does not with a plain duplicate). Refused
     * when this launcher runs elevated, as for the other profiles.
     */
    static IntPtr BuildPresentToken() {
        IntPtr current;
        if (!N.OpenProcessToken(N.GetCurrentProcess(), 0xF01FF, out current)) throw new Fail(EXIT_CONTAINMENT, "OpenProcessToken failed: " + Marshal.GetLastWin32Error());
        if (IntegrityOf(current) > 0x2000) throw new Fail(EXIT_CONTAINMENT, "nexus-launch was started elevated; it only runs as an ordinary user process");
        IntPtr same;
        if (!N.CreateRestrictedToken(current, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out same)) throw new Fail(EXIT_CONTAINMENT, "CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
        IntPtr token;
        if (!N.DuplicateTokenEx(same, 0xF01FF, IntPtr.Zero, 2, 1 /* primary */, out token)) throw new Fail(EXIT_CONTAINMENT, "DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
        N.CloseHandle(same); N.CloseHandle(current);
        return token;
    }

    /** A copy of this process's token with every privilege but "bypass traverse checking" removed, at low integrity. */
    static IntPtr BuildToken(Spec spec) {
        IntPtr current;
        if (!N.OpenProcessToken(N.GetCurrentProcess(), 0xF01FF, out current)) throw new Fail(EXIT_CONTAINMENT, "OpenProcessToken failed: " + Marshal.GetLastWin32Error());
        // The launcher itself must be an ordinary process of the user. Started elevated it would hand down more than a user has.
        if (IntegrityOf(current) > 0x2000) throw new Fail(EXIT_CONTAINMENT, "nexus-launch was started elevated; it only runs as an ordinary user process");
        IntPtr stripped;
        if (!N.CreateRestrictedToken(current, 1 /* DISABLE_MAX_PRIVILEGE */, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out stripped)) throw new Fail(EXIT_CONTAINMENT, "CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
        IntPtr token;
        if (!N.DuplicateTokenEx(stripped, 0xF01FF, IntPtr.Zero, 2, 1 /* primary */, out token)) throw new Fail(EXIT_CONTAINMENT, "DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
        N.CloseHandle(stripped); N.CloseHandle(current);
        {
            TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
            label.Label.Sid = Sid("S-1-16-4096"); label.Label.Attributes = 0x20;
            IntPtr b = Marshal.AllocHGlobal(Marshal.SizeOf(label)); Marshal.StructureToPtr(label, b, false);
            if (!N.SetTokenInformation(token, 25, b, Marshal.SizeOf(label) + (int)N.GetLengthSid(label.Label.Sid))) throw new Fail(EXIT_CONTAINMENT, "the token could not be set to low integrity: " + Marshal.GetLastWin32Error());
            // Do not take the call's word for it: read the level back from the token that will be used.
            if (IntegrityOf(token) != 0x1000) throw new Fail(EXIT_CONTAINMENT, "the token is not at low integrity after it was set");
        }
        return token;
    }

    static IntPtr BuildJob(Spec spec) {
        IntPtr job = N.CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "CreateJobObject failed: " + Marshal.GetLastWin32Error());
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION ex = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // Kill on close and no breakaway flag: nothing started inside leaves, and all of it ends with this launcher.
        ex.Basic.LimitFlags = JOB_KILL_ON_CLOSE | JOB_ACTIVE_PROCESS | JOB_DIE_ON_UNHANDLED;
        ex.Basic.ActiveProcessLimit = spec.MaxProcesses;
        if (spec.MaxJobMemory > 0) { ex.Basic.LimitFlags |= JOB_MEMORY; ex.JobMemoryLimit = new UIntPtr(spec.MaxJobMemory); }
        IntPtr b = Marshal.AllocHGlobal(Marshal.SizeOf(ex)); Marshal.StructureToPtr(ex, b, false);
        if (!N.SetInformationJobObject(job, 9, b, Marshal.SizeOf(ex))) throw new Fail(EXIT_CONTAINMENT, "the job limits could not be set: " + Marshal.GetLastWin32Error());
        IntPtr u = Marshal.AllocHGlobal(4); Marshal.WriteInt32(u, (int)spec.UiLimits);
        if (!N.SetInformationJobObject(job, 4, u, 4)) throw new Fail(EXIT_CONTAINMENT, "the job UI restrictions could not be set: " + Marshal.GetLastWin32Error());
        return job;
    }

    /** The environment block: exactly the spec's variables, nothing of the launcher's own. */
    static IntPtr BuildEnvironment(Spec spec) {
        SortedDictionary<string, string> vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string entry in spec.Env) {
            int i = entry.IndexOf('=');
            if (i <= 0) throw new Fail(EXIT_SPEC, "an environment entry has no name");
            if (entry.IndexOf('\0') >= 0) throw new Fail(EXIT_SPEC, "an environment entry contains a NUL");
            vars[entry.Substring(0, i)] = entry.Substring(i + 1);
        }
        StringBuilder sb = new StringBuilder();
        foreach (KeyValuePair<string, string> kv in vars) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static IntPtr StdOrNul(int which, uint access) {
        IntPtr h = N.GetStdHandle(which);
        if (h != IntPtr.Zero && h != new IntPtr(-1)) { N.SetHandleInformation(h, 1, 1); return h; }
        // No handle was given (started without a console and without pipes): the child gets NUL, not nothing.
        IntPtr nul = N.CreateFileW("NUL", access, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
        N.SetHandleInformation(nul, 1, 1);
        return nul;
    }

    static void WriteReport(Spec spec, IntPtr job, uint pid, string exit) {
        if (spec.Report == null) return;
        try {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            IntPtr b = Marshal.AllocHGlobal(Marshal.SizeOf(a)); int r;
            uint total = 0, active = 0;
            if (N.QueryInformationJobObject(job, 1, b, Marshal.SizeOf(a), out r)) {
                a = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(b, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                total = a.TotalProcesses; active = a.ActiveProcesses;
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION ex = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            IntPtr eb = Marshal.AllocHGlobal(Marshal.SizeOf(ex)); ulong peak = 0;
            if (N.QueryInformationJobObject(job, 9, eb, Marshal.SizeOf(ex), out r)) {
                ex = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(eb, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                peak = ex.PeakJobMemoryUsed.ToUInt64();
            }
            File.WriteAllText(spec.Report, "profile=" + spec.Profile + "\npid=" + pid + "\nexit=" + exit + "\ntotal-processes=" + total + "\nactive-at-exit=" + active + "\npeak-job-memory=" + peak + "\n");
        } catch (Exception) { }
    }

    static string SpecLine(string key, string value) { return key + "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value)) + "\n"; }

    /**
     * ISOLATED, first step, as the user: log the sandbox account on and start this program's copy as that
     * account, suspended, in the job. The copy gets an inner spec (profile STAGE2) and does the rest. The
     * account's password is read from the user's protected blob here and goes nowhere else.
     */
    static int RunAsSandboxAccount(Spec spec) {
        if (!File.Exists(spec.Stage2)) throw new Fail(EXIT_CONTAINMENT, "the launcher for the sandbox account is missing: " + spec.Stage2);
        // The copy is named after its content. The account can write where it lies (at medium integrity only, which
        // contained code never has); a copy that is no longer what its name says is not started.
        string digest; using (SHA256 sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(spec.Stage2))).Replace("-", "").ToLowerInvariant();
        if (Path.GetFileName(spec.Stage2).ToLowerInvariant().IndexOf(digest.Substring(0, 16)) < 0) throw new Fail(EXIT_CONTAINMENT, "the launcher for the sandbox account is not the file it is named after: " + spec.Stage2);
        string[] credential = CredentialRead(spec.Credential);
        // Who the stored name is on this machine now, and that it is the account NEXUS verified.
        string accountSid;
        try { accountSid = ((System.Security.Principal.SecurityIdentifier)new System.Security.Principal.NTAccount(Environment.MachineName, credential[0]).Translate(typeof(System.Security.Principal.SecurityIdentifier))).Value; }
        catch (Exception) { throw new Fail(EXIT_CONTAINMENT, "the sandbox account on record does not exist on this machine"); }
        if (spec.AccountSid != null && !string.Equals(spec.AccountSid, accountSid, StringComparison.OrdinalIgnoreCase)) throw new Fail(EXIT_CONTAINMENT, "the sandbox account on record is not the account that was verified");
        IntPtr job = BuildJob(spec);
        // The desktop of the command is made here, by the user: the job then keeps its limit on desktops, so nothing
        // inside makes one or switches to one. Kept open while this launcher lives.
        //
        // How the account's process gets onto it. Windows starts a process "as another user" on the desktop of the
        // thread that asks, and gives its token the asking session's logon identifier, by which it may use that
        // desktop, the window station and the session's named objects. Naming a desktop to Windows instead leaves
        // that identifier out, and a process without it cannot create a named object in the session at all
        // (measured: Git Bash dies at start). So no desktop is named: this thread moves to the new desktop first,
        // and the account's process is started from there. It never is on the desktop the user sees.
        string desktopName = spec.Desktop != null ? spec.Desktop : RandomDesktopName();
        // In an AppContainer a process opens a desktop only if the account and the AppContainer are both let in.
        // With a capability of the session's own, the desktop is open to holders of that capability and not to the
        // whole AppContainer: another session's command cannot open it even if it learns its name.
        IntPtr desktop = MakeDesktop(desktopName, accountSid, spec.Capabilities.Count > 0 ? SidText(CapabilitySid(spec.Capabilities[0])) : spec.AppContainer != null ? SidText(AppContainerSid(spec.AppContainer)) : null);
        // The identifier would let the account open the user's own desktop too, and read the screen from it
        // (measured). The account itself is refused there, and refused the screen and the clipboard of the window
        // station: a refusal by name outranks what the identifier allows.
        RefuseUsersDesktop(accountSid);
        if (!N.SetThreadDesktop(desktop)) throw new Fail(EXIT_CONTAINMENT, "this launcher could not move to the command's desktop: " + Marshal.GetLastWin32Error());

        StringBuilder inner = new StringBuilder();
        inner.Append("version=1\nprofile=STAGE2\n");
        inner.Append(SpecLine("cwd", spec.Cwd)).Append(SpecLine("command", spec.Command));
        foreach (string entry in spec.Env) inner.Append(SpecLine("env", entry));
        inner.Append("max-processes=" + spec.MaxProcesses + "\n");
        if (spec.MaxJobMemory > 0) inner.Append("max-job-memory=" + spec.MaxJobMemory + "\n");
        inner.Append("ui-limits=" + spec.UiLimits + "\n");
        if (spec.Window) inner.Append("window=1\n");
        inner.Append("expect-sid=" + accountSid + "\n");
        inner.Append("desktop=" + desktopName + "\n");
        if (spec.AppContainer != null) inner.Append("appcontainer=" + spec.AppContainer + "\n");
        foreach (string capability in spec.Capabilities) inner.Append("capability=" + capability + "\n");
        byte[] name = new byte[12]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(name);
        string innerPath = Path.Combine(spec.Stage2Dir, BitConverter.ToString(name).Replace("-", "").ToLowerInvariant() + ".spec");
        try { Directory.CreateDirectory(spec.Stage2Dir); File.WriteAllText(innerPath, inner.ToString(), new UTF8Encoding(false)); }
        catch (Exception e) { throw new Fail(EXIT_CONTAINMENT, "the inner spec could not be written: " + e.Message); }

        // The copy itself needs only what Windows needs; the command's environment is in the inner spec.
        StringBuilder envBlock = new StringBuilder();
        foreach (string key in new string[] { "ComSpec", "PATHEXT", "SystemDrive", "SystemRoot", "windir" }) {
            string value = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrEmpty(value)) envBlock.Append(key).Append('=').Append(value).Append('\0');
        }
        envBlock.Append('\0');
        IntPtr env = Marshal.StringToHGlobalUni(envBlock.ToString());

        STARTUPINFO si = new STARTUPINFO();
        si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = StdOrNul(-10, 0x80000000);
        si.hStdOutput = StdOrNul(-11, 0x40000000);
        si.hStdError = StdOrNul(-12, 0x40000000);
        StringBuilder commandLine = new StringBuilder("\"" + spec.Stage2 + "\" --spec \"" + innerPath + "\"");
        PROCESS_INFORMATION pi;
        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | (spec.Window ? 0 : CREATE_NO_WINDOW);
        // Logon flags 0: no profile is loaded for the account; its home is a directory of the session. With an
        // AppContainer the account's own profile is loaded (LOGON_WITH_PROFILE): Windows keeps an AppContainer's
        // record in the registry of the account that uses it, and starts no process in one that has no record
        // (measured: "file not found"). The command's home is still the session's directory, by its environment.
        // Its current directory is the folder of the launcher's copy, not the worktree: Windows looks in the current
        // directory for a library it does not find elsewhere, and the worktree is written by contained code. The
        // command itself is started in the worktree by the second step.
        bool started = N.CreateProcessWithLogonW(credential[0], ".", credential[1], spec.AppContainer != null ? 1u : 0u, null, commandLine, flags, env, Path.GetDirectoryName(spec.Stage2), ref si, out pi);
        int startError = Marshal.GetLastWin32Error();
        credential[1] = null;
        if (!started) {
            try { File.Delete(innerPath); } catch (Exception) { }
            throw new Fail(EXIT_CONTAINMENT, "the sandbox account could not start a process: " + new Win32Exception(startError).Message + " (" + startError + ")");
        }
        bool inJob = false;
        if (!N.AssignProcessToJobObject(job, pi.hProcess) || !N.IsProcessInJob(pi.hProcess, job, out inJob) || !inJob) {
            int e = Marshal.GetLastWin32Error();
            N.TerminateProcess(pi.hProcess, 1);
            try { File.Delete(innerPath); } catch (Exception) { }
            throw new Fail(EXIT_CONTAINMENT, "the sandbox account's process could not be put in its job: " + e);
        }
        if (N.ResumeThread(pi.hThread) == 0xFFFFFFFF) {
            int e = Marshal.GetLastWin32Error();
            N.TerminateJobObject(job, 1);
            try { File.Delete(innerPath); } catch (Exception) { }
            throw new Fail(EXIT_CONTAINMENT, "the sandbox account's process could not be let run: " + e);
        }
        N.CloseHandle(pi.hThread);
        uint waited = N.WaitForSingleObject(pi.hProcess, spec.TimeoutMs == 0 ? 0xFFFFFFFF : spec.TimeoutMs);
        try { File.Delete(innerPath); } catch (Exception) { }
        if (waited != 0) {
            N.TerminateJobObject(job, (uint)EXIT_TIMEOUT);
            WriteReport(spec, job, pi.dwProcessId, "timeout");
            return EXIT_TIMEOUT;
        }
        uint code; N.GetExitCodeProcess(pi.hProcess, out code);
        WriteReport(spec, job, pi.dwProcessId, code.ToString());
        N.TerminateJobObject(job, 0);
        N.CloseHandle(job);
        N.CloseDesktop(desktop);
        return (int)code;
    }

    /** The SID Windows derives from an AppContainer's name. The same name gives the same SID on every machine; no profile is made for it. */
    static IntPtr AppContainerSid(string name) {
        IntPtr sid; int hr = N.DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0 || sid == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "the AppContainer's SID could not be derived: 0x" + hr.ToString("x"));
        return sid;
    }

    /**
     * The SID of NEXUS's own capability of that name. The folders of the sandbox are opened to this SID and not to
     * the AppContainer's own: an access list that names an AppContainer keeps every low-integrity program out of
     * the folder (measured), and one that names a capability does not.
     */
    static IntPtr CapabilitySid(string name) {
        IntPtr groups, caps; uint groupCount, capCount;
        if (!N.DeriveCapabilitySidsFromName(name, out groups, out groupCount, out caps, out capCount) || capCount < 1 || caps == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "the capability's SID could not be derived: " + Marshal.GetLastWin32Error());
        IntPtr sid = Marshal.ReadIntPtr(caps);
        if (sid == IntPtr.Zero || !SidText(sid).StartsWith("S-1-15-3-1024-")) throw new Fail(EXIT_CONTAINMENT, "the capability's SID is not one of a named capability");
        return sid;
    }

    static string SidText(IntPtr sid) {
        IntPtr s; if (!N.ConvertSidToStringSidW(sid, out s)) throw new Fail(EXIT_CONTAINMENT, "a SID could not be written out: " + Marshal.GetLastWin32Error());
        string text = Marshal.PtrToStringUni(s); N.LocalFree(s); return text;
    }

    static IntPtr TokenInfo(IntPtr token, int cls, string what) {
        int need; N.GetTokenInformation(token, cls, IntPtr.Zero, 0, out need);
        if (need <= 0) throw new Fail(EXIT_CONTAINMENT, what + " cannot be read from the command's token: " + Marshal.GetLastWin32Error());
        IntPtr buf = Marshal.AllocHGlobal(need);
        if (!N.GetTokenInformation(token, cls, buf, need, out need)) throw new Fail(EXIT_CONTAINMENT, what + " cannot be read from the command's token: " + Marshal.GetLastWin32Error());
        return buf;
    }

    /**
     * Reads back from the process that was made (still suspended) that it is in the AppContainer that was asked
     * for and holds NEXUS's one capability and no other: not the call's word, the token's. A process that is
     * not, is not let run.
     */
    static void RequireAppContainer(IntPtr process, IntPtr expected, List<IntPtr> capabilities) {
        IntPtr token;
        if (!N.OpenProcessToken(process, 0x8 /* TOKEN_QUERY */, out token)) throw new Fail(EXIT_CONTAINMENT, "the command's token could not be opened to check its AppContainer: " + Marshal.GetLastWin32Error());
        try {
            IntPtr b = TokenInfo(token, 29 /* TokenIsAppContainer */, "whether it is in an AppContainer");
            if (Marshal.ReadInt32(b) == 0) throw new Fail(EXIT_CONTAINMENT, "the command was not started in an AppContainer");
            b = TokenInfo(token, 31 /* TokenAppContainerSid */, "its AppContainer");
            IntPtr sid = Marshal.ReadIntPtr(b);
            if (sid == IntPtr.Zero || !N.EqualSid(sid, expected)) throw new Fail(EXIT_CONTAINMENT, "the command is not in the AppContainer that was asked for");
            b = TokenInfo(token, 30 /* TokenCapabilities */, "its capabilities");
            // TOKEN_GROUPS { GroupCount, SID_AND_ATTRIBUTES[] }: the array begins at the pointer's alignment.
            int held = Marshal.ReadInt32(b);
            if (held != capabilities.Count) throw new Fail(EXIT_CONTAINMENT, "the command's AppContainer does not hold exactly the capabilities it was given");
            int entry = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (int i = 0; i < held; i++) {
                IntPtr sid2 = Marshal.ReadIntPtr(b, IntPtr.Size + i * entry);
                bool known = false;
                foreach (IntPtr given in capabilities) if (N.EqualSid(sid2, given)) known = true;
                if (!known) throw new Fail(EXIT_CONTAINMENT, "the command's AppContainer holds a capability it was not given");
            }
        } finally { N.CloseHandle(token); }
    }

    /**
     * 0.9. Two commands of two sessions are the same account in the same AppContainer, and Windows lets such
     * processes open one another: what a process is made with, and what it gives to everything it creates without
     * a list of its own (its children, their threads, its pipes and events), names the account and the
     * AppContainer. One session could end another's processes, read their memory and take their handles, and
     * with them everything the other session holds.
     *
     * So the list is replaced by one that names the system, the account and the session's own capability, and
     * not the AppContainer: on the process, on its first thread, and as the default of its token, which every
     * process it starts inherits. A process is opened by code in an AppContainer only where the list names its
     * AppContainer or a capability it holds; another session holds neither.
     */
    static void CloseToOtherSessions(IntPtr process, IntPtr thread, string accountSid, string sessionCapability) {
        if (accountSid == null) throw new Fail(EXIT_CONTAINMENT, "the account of the command is not known, so its process cannot be closed to other sessions");
        IntPtr sd; uint size;
        if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;SY)(A;;GA;;;" + accountSid + ")(A;;GA;;;" + sessionCapability + ")", 1, out sd, out size)) throw new Fail(EXIT_CONTAINMENT, "the session's access list could not be built: " + Marshal.GetLastWin32Error());
        try {
            bool present, defaulted; IntPtr dacl;
            if (!N.GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "the session's access list could not be read back");
            // DACL | PROTECTED_DACL: exactly this list.
            uint r = N.SetSecurityInfo(process, 6 /* SE_KERNEL_OBJECT */, 0x4 | 0x80000000, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (r != 0) throw new Fail(EXIT_CONTAINMENT, "the command's process could not be closed to other sessions: " + r);
            r = N.SetSecurityInfo(thread, 6, 0x4 | 0x80000000, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (r != 0) throw new Fail(EXIT_CONTAINMENT, "the command's thread could not be closed to other sessions: " + r);
            IntPtr token;
            if (!N.OpenProcessToken(process, 0x8 | 0x80 /* TOKEN_QUERY | TOKEN_ADJUST_DEFAULT */, out token)) throw new Fail(EXIT_CONTAINMENT, "the command's token could not be opened to set what it gives to what it creates: " + Marshal.GetLastWin32Error());
            try {
                // TOKEN_DEFAULT_DACL { PACL DefaultDacl }
                IntPtr info = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(info, dacl);
                bool set = N.SetTokenInformation(token, 6 /* TokenDefaultDacl */, info, IntPtr.Size);
                int e = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(info);
                if (!set) throw new Fail(EXIT_CONTAINMENT, "the default access list of the command's token could not be set: " + e);
                // Read back: the default the token now carries has three entries and none for the AppContainer.
                IntPtr b = TokenInfo(token, 6, "its default access list");
                IntPtr now = Marshal.ReadIntPtr(b);
                if (now == IntPtr.Zero || Marshal.ReadInt16(now, 4) != 3) throw new Fail(EXIT_CONTAINMENT, "the default access list of the command's token is not the session's after it was set");
            } finally { N.CloseHandle(token); }
        } finally { N.LocalFree(sd); }
    }

    static string RandomDesktopName() {
        byte[] name = new byte[8]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(name);
        return "nx-" + BitConverter.ToString(name).Replace("-", "").ToLowerInvariant();
    }

    /** Adds or replaces the entry of one account in the access list of a window station or desktop: `mode` 3 refuses the rights, 2 allows exactly them. */
    static void SetWindowObjectAccess(IntPtr handle, string sid, int mode, uint rights, string what) {
        IntPtr dacl, sd;
        uint r = N.GetSecurityInfo(handle, 7 /* SE_WINDOW_OBJECT */, 0x4, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
        if (r != 0) throw new Fail(EXIT_CONTAINMENT, "the access list of " + what + " could not be read: " + r);
        EXPLICIT_ACCESS ea = new EXPLICIT_ACCESS();
        ea.grfAccessPermissions = rights; ea.grfAccessMode = mode; ea.grfInheritance = 0;
        ea.Trustee.TrusteeForm = 0 /* TRUSTEE_IS_SID */; ea.Trustee.TrusteeType = 1 /* user */; ea.Trustee.ptstrName = Sid(sid);
        IntPtr merged;
        r = N.SetEntriesInAclW(1, ref ea, dacl, out merged);
        if (r != 0) { N.LocalFree(sd); throw new Fail(EXIT_CONTAINMENT, "the access list of " + what + " could not be extended: " + r); }
        r = N.SetSecurityInfo(handle, 7, 0x4, IntPtr.Zero, IntPtr.Zero, merged, IntPtr.Zero);
        N.LocalFree(merged); N.LocalFree(sd);
        if (r != 0) throw new Fail(EXIT_CONTAINMENT, "the access list of " + what + " could not be set: " + r);
    }

    /**
     * Refuses the sandbox account the desktop the user works on (every right), and on the window station the
     * screen, the clipboard, listing and making desktops and changing attributes. Both lists are the user's to change, and the
     * entries stay for the session: they name an account that has no business there. If it cannot be done,
     * nothing is started.
     */
    static void RefuseUsersDesktop(string sid) {
        IntPtr users = N.OpenDesktopW("Default", 0, false, 0x00020000 | 0x00040000 /* READ_CONTROL | WRITE_DAC */);
        if (users == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "the user's desktop could not be opened to close it to the sandbox account: " + Marshal.GetLastWin32Error());
        try { SetWindowObjectAccess(users, sid, 3 /* DENY_ACCESS */, 0x000F01FF, "the user's desktop"); } finally { N.CloseDesktop(users); }
        IntPtr station = N.GetProcessWindowStation();
        if (station == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "this process has no window station");
        // WINSTA_ENUMDESKTOPS | WINSTA_ACCESSCLIPBOARD | WINSTA_CREATEDESKTOP | WINSTA_WRITEATTRIBUTES | WINSTA_READSCREEN.
        // Not listing desktops: the desktop of another contained command is open to the same account, and what
        // keeps one command from another's is that it cannot learn its name (64 random bits).
        SetWindowObjectAccess(station, sid, 3, 0x1 | 0x4 | 0x8 | 0x10 | 0x200, "the window station");
    }

    /**
     * A desktop of the command's own on this window station: what the command shows is on no screen and takes no
     * input of the user's. Labeled low so that the low-integrity command can use it, and open to its owner only
     * (the account that runs the command): no other account and no other session's application reaches it. If it cannot be made, nothing
     * is started: there is no falling back to the user's desktop.
     */
    static IntPtr MakeDesktop(string name, string alsoFor, string appContainer) {
        IntPtr sd; uint size;
        if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;OW)(A;;GA;;;SY)" + (alsoFor != null ? "(A;;GA;;;" + alsoFor + ")" : "") + (appContainer != null ? "(A;;GA;;;" + appContainer + ")" : "") + "S:(ML;;NW;;;LW)", 1, out sd, out size)) throw new Fail(EXIT_CONTAINMENT, "the desktop's security could not be built: " + Marshal.GetLastWin32Error());
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.lpSecurityDescriptor = sd; sa.bInheritHandle = false;
        IntPtr desktop = N.CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000 /* GENERIC_ALL */, ref sa);
        int e = Marshal.GetLastWin32Error();
        N.LocalFree(sd);
        if (desktop == IntPtr.Zero) throw new Fail(EXIT_CONTAINMENT, "a desktop for the command could not be made: " + new Win32Exception(e).Message + " (" + e + ")");
        return desktop;
    }

    static int Run(Spec spec) {
        if (spec.Profile == "ISOLATED") return RunAsSandboxAccount(spec);
        // The second step of ISOLATED already runs inside the job the first step made, and Windows does not nest a
        // job under one that sets UI limits. The command inherits that job; none is made here.
        bool inner = spec.Profile == "STAGE2";
        if (inner) {
            // The second step is the account's own process: it says who it is, and that must be who was meant.
            string self = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            if (spec.ExpectSid == null || !string.Equals(spec.ExpectSid, self, StringComparison.OrdinalIgnoreCase)) throw new Fail(EXIT_CONTAINMENT, "the inner step does not run as the sandbox account it was started for");
        }
        IntPtr job = inner ? IntPtr.Zero : BuildJob(spec);
        IntPtr token = spec.Profile == "PRESENT" ? BuildPresentToken() : BuildToken(spec);
        IntPtr env = spec.InheritEnv ? IntPtr.Zero : BuildEnvironment(spec);

        STARTUPINFOEX six = new STARTUPINFOEX();
        six.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        six.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        six.StartupInfo.hStdInput = StdOrNul(-10, 0x80000000);
        six.StartupInfo.hStdOutput = StdOrNul(-11, 0x40000000);
        six.StartupInfo.hStdError = StdOrNul(-12, 0x40000000);
        // Every command has a desktop of its own, whether it shows a window or not: on the user's desktop a process
        // can read the screen, whatever its integrity (measured by the audit of 0.8). Kept open for as long as this
        // launcher lives, which is as long as the command does. The second step of ISOLATED is on the desktop the
        // first step made for it, and the command inherits that.
        IntPtr desktop = IntPtr.Zero;
        if (!inner) {
            string desktopName = spec.Desktop != null ? spec.Desktop : RandomDesktopName();
            desktop = MakeDesktop(desktopName, null, null);
            six.StartupInfo.lpDesktop = "WinSta0\\" + desktopName;
        } else if (spec.Desktop != null) six.StartupInfo.lpDesktop = "WinSta0\\" + spec.Desktop;
        // The command inherits its three standard handles and no other. This launcher holds whatever its parent
        // let it inherit (pipes and files of the runtime and of whatever started that), and without a list every
        // one of them would be the command's too, with the access it was opened with.
        List<IntPtr> handles = new List<IntPtr>();
        foreach (IntPtr h in new IntPtr[] { six.StartupInfo.hStdInput, six.StartupInfo.hStdOutput, six.StartupInfo.hStdError }) if (!handles.Contains(h)) handles.Add(h);
        // The AppContainer is made here, at the last step: the process that starts the command is the account's own
        // and is in none. Only the second step of ISOLATED has one.
        IntPtr appContainer = inner && spec.AppContainer != null ? AppContainerSid(spec.AppContainer) : IntPtr.Zero;
        if (!inner && spec.AppContainer != null) throw new Fail(EXIT_SPEC, "an AppContainer is part of the ISOLATED profile only");
        List<IntPtr> capabilities = new List<IntPtr>();
        if (appContainer != IntPtr.Zero) {
            capabilities.Add(CapabilitySid(spec.AppContainer));
            foreach (string name in spec.Capabilities) {
                IntPtr sid = CapabilitySid(name);
                foreach (IntPtr known in capabilities) if (N.EqualSid(known, sid)) throw new Fail(EXIT_SPEC, "a capability is named twice");
                capabilities.Add(sid);
            }
        }
        int attributes = appContainer != IntPtr.Zero ? 2 : 1;
        IntPtr listSize = IntPtr.Zero;
        N.InitializeProcThreadAttributeList(IntPtr.Zero, attributes, 0, ref listSize);
        six.lpAttributeList = Marshal.AllocHGlobal(listSize);
        IntPtr handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
        for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, handles[i]);
        if (!N.InitializeProcThreadAttributeList(six.lpAttributeList, attributes, 0, ref listSize) || !N.UpdateProcThreadAttribute(six.lpAttributeList, 0, new IntPtr(0x00020002) /* PROC_THREAD_ATTRIBUTE_HANDLE_LIST */, handleArray, new IntPtr(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero))
            throw new Fail(EXIT_CONTAINMENT, "the list of handles the command may inherit could not be made: " + Marshal.GetLastWin32Error());
        if (appContainer != IntPtr.Zero) {
            // The AppContainer's record in this account's registry: made the first time, found there afterwards.
            IntPtr made; int hr = N.CreateAppContainerProfile(spec.AppContainer, spec.AppContainer, "NEXUS: contained project code, no capability", IntPtr.Zero, 0, out made);
            if (hr != 0 && (uint)hr != 0x800700B7 /* already exists */) throw new Fail(EXIT_CONTAINMENT, "the AppContainer could not be registered for the sandbox account: 0x" + hr.ToString("x"));
            // SECURITY_CAPABILITIES { AppContainerSid, Capabilities, CapabilityCount, Reserved }: NEXUS's own
            // capability and nothing of Windows' (no network, no library, no device).
            int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            IntPtr list1 = Marshal.AllocHGlobal(entrySize * capabilities.Count);
            for (int i = 0; i < capabilities.Count; i++) {
                SID_AND_ATTRIBUTES own = new SID_AND_ATTRIBUTES(); own.Sid = capabilities[i]; own.Attributes = 0x4 /* SE_GROUP_ENABLED */;
                Marshal.StructureToPtr(own, new IntPtr(list1.ToInt64() + i * entrySize), false);
            }
            IntPtr caps = Marshal.AllocHGlobal(IntPtr.Size * 2 + 8);
            Marshal.WriteIntPtr(caps, 0, appContainer); Marshal.WriteIntPtr(caps, IntPtr.Size, list1); Marshal.WriteInt32(caps, IntPtr.Size * 2, capabilities.Count); Marshal.WriteInt32(caps, IntPtr.Size * 2 + 4, 0);
            if (!N.UpdateProcThreadAttribute(six.lpAttributeList, 0, new IntPtr(0x00020009) /* PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES */, caps, new IntPtr(IntPtr.Size * 2 + 8), IntPtr.Zero, IntPtr.Zero))
                throw new Fail(EXIT_CONTAINMENT, "the AppContainer of the command could not be set: " + Marshal.GetLastWin32Error());
        }

        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | (spec.Window ? 0 : CREATE_NO_WINDOW);
        PROCESS_INFORMATION pi;
        StringBuilder commandLine = new StringBuilder(spec.Command);
        // Suspended: the process exists and has run nothing when it is put in the job.
        bool created = N.CreateProcessAsUserExW(token, null, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, env, spec.Cwd, ref six, out pi);
        int createError = Marshal.GetLastWin32Error();
        N.DeleteProcThreadAttributeList(six.lpAttributeList);
        if (!created) {
            int e = createError;
            throw new Fail(EXIT_START, "the command could not be started: " + new Win32Exception(e).Message + " (" + e + ")");
        }
        if (appContainer != IntPtr.Zero) {
            try {
                RequireAppContainer(pi.hProcess, appContainer, capabilities);
                // The session's own capability, when there is one: this process, its first thread and everything it
                // makes from now on without saying who may open it are for holders of that capability, not for the
                // whole AppContainer. Done while the process is suspended and has run nothing.
                if (spec.Capabilities.Count > 0) CloseToOtherSessions(pi.hProcess, pi.hThread, spec.ExpectSid, SidText(capabilities[1]));
            }
            catch (Fail) { N.TerminateProcess(pi.hProcess, 1); throw; }
        }
        bool inJob = false;
        if (inner) {
            // Some job must hold this process already: if none does, the first step did not do its part.
            if (!N.IsProcessInJob(pi.hProcess, IntPtr.Zero, out inJob) || !inJob) {
                N.TerminateProcess(pi.hProcess, 1);
                throw new Fail(EXIT_CONTAINMENT, "the command is in no job: the inner step was started outside the containment");
            }
        } else if (!N.AssignProcessToJobObject(job, pi.hProcess) || !N.IsProcessInJob(pi.hProcess, job, out inJob) || !inJob) {
            int e = Marshal.GetLastWin32Error();
            N.TerminateProcess(pi.hProcess, 1);
            throw new Fail(EXIT_CONTAINMENT, "the process could not be put in its job: " + e);
        }
        if (N.ResumeThread(pi.hThread) == 0xFFFFFFFF) {
            int e = Marshal.GetLastWin32Error();
            N.TerminateProcess(pi.hProcess, 1);
            throw new Fail(EXIT_CONTAINMENT, "the command could not be let run: " + e);
        }
        N.CloseHandle(pi.hThread);

        uint waited = N.WaitForSingleObject(pi.hProcess, spec.TimeoutMs == 0 ? 0xFFFFFFFF : spec.TimeoutMs);
        if (waited != 0) {
            if (inner) N.TerminateProcess(pi.hProcess, (uint)EXIT_TIMEOUT); else N.TerminateJobObject(job, (uint)EXIT_TIMEOUT);
            if (!inner) WriteReport(spec, job, pi.dwProcessId, "timeout");
            return EXIT_TIMEOUT;
        }
        uint code; N.GetExitCodeProcess(pi.hProcess, out code);
        if (inner) return (int)code;
        WriteReport(spec, job, pi.dwProcessId, code.ToString());
        // The command has ended: whatever it left running ends with it. A long-lived process is its own launch.
        N.TerminateJobObject(job, 0);
        N.CloseHandle(job);
        return (int)code;
    }

    /** Sets or clears the mandatory label of a directory tree: `low` makes it writable from the containment, `medium` readable and not writable (the default, said explicitly so that a protected parent does not apply), `protect` unreadable from it, `clear` removes the label. */
    static int Label(string mode, string path) {
        if (!Directory.Exists(path) && !File.Exists(path)) throw new Fail(EXIT_SPEC, "no such path");
        string sddl = mode == "low" ? "S:(ML;OICI;NW;;;LW)" : mode == "protect" ? "S:(ML;OICI;NWNRNX;;;ME)" : mode == "medium" ? "S:(ML;OICI;NW;;;ME)" : mode == "clear" ? "S:" : null;
        if (sddl == null) throw new Fail(EXIT_USAGE, "label mode must be low, medium, protect or clear");
        IntPtr sd; uint size;
        if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) throw new Fail(EXIT_CONTAINMENT, "the label could not be built: " + Marshal.GetLastWin32Error());
        bool present, defaulted; IntPtr sacl;
        if (!N.GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Fail(EXIT_CONTAINMENT, "the label could not be read back: " + Marshal.GetLastWin32Error());
        // LABEL_SECURITY_INFORMATION only: the owner, the group and the access list are not touched.
        uint result = N.SetNamedSecurityInfoW(path, 1 /* SE_FILE_OBJECT */, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        N.LocalFree(sd);
        if (result != 0) throw new Fail(EXIT_CONTAINMENT, "the label could not be set: " + result);
        return 0;
    }

    /**
     * Narrows who may open a named pipe that already exists: the user who runs this and the system, and nobody
     * at an integrity below medium, neither to write nor to read. Windows gives a pipe made without a security
     * descriptor a list that lets everyone connect for reading; and a process of the same user at low
     * integrity is the same user. The pipe is opened here with the right to change its protection only, by the
     * user who made it; no byte is written to it.
     */
    static int PipeProtect(string pipe) {
        if (!pipe.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase)) throw new Fail(EXIT_USAGE, "not a pipe name");
        string user = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        IntPtr sd; uint size;
        if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;" + user + ")(A;;GA;;;SY)S:(ML;;NWNR;;;ME)", 1, out sd, out size)) throw new Fail(EXIT_CONTAINMENT, "the pipe's protection could not be built: " + Marshal.GetLastWin32Error());
        bool present, defaulted; IntPtr dacl, sacl;
        if (!N.GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted) || !N.GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Fail(EXIT_CONTAINMENT, "the pipe's protection could not be read back: " + Marshal.GetLastWin32Error());
        // READ_CONTROL | WRITE_DAC | WRITE_OWNER: enough to set the list and the label, not to read or write the pipe.
        IntPtr h = IntPtr.Zero;
        // Every instance of the pipe may be taken at this moment (ERROR_PIPE_BUSY): wait for one, a few times.
        for (int attempt = 0; attempt < 40; attempt++) {
            h = N.CreateFileW(pipe, 0x00020000 | 0x00040000 | 0x00080000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h != IntPtr.Zero && h != new IntPtr(-1)) break;
            if (Marshal.GetLastWin32Error() != 231) break;
            N.WaitNamedPipeW(pipe, 250);
        }
        if (h == IntPtr.Zero || h == new IntPtr(-1)) throw new Fail(EXIT_CONTAINMENT, "the pipe could not be opened to protect it: " + Marshal.GetLastWin32Error());
        // DACL | PROTECTED_DACL (nothing inherited) | LABEL.
        uint result = N.SetSecurityInfo(h, 6 /* SE_KERNEL_OBJECT */, 0x4 | 0x80000000 | 0x10, IntPtr.Zero, IntPtr.Zero, dacl, sacl);
        N.CloseHandle(h);
        N.LocalFree(sd);
        if (result != 0) throw new Fail(EXIT_CONTAINMENT, "the pipe's protection could not be set: " + result);
        return 0;
    }

    // The sandbox account's password, kept as a DPAPI blob only the user who stored it can open. The entropy
    // ties the blob to this use; the protection is the user's own key.
    static readonly byte[] CredentialEntropy = Encoding.UTF8.GetBytes("nexus-launch/sandbox-credential/1");

    /** Reads `account` and a password from standard input (two lines) and stores them protected at `path`. */
    static int CredentialWrite(string path) {
        string account = Console.In.ReadLine();
        string password = Console.In.ReadLine();
        if (string.IsNullOrEmpty(account) || string.IsNullOrEmpty(password) || password.Length < 24) throw new Fail(EXIT_SPEC, "expected an account name and a password on standard input");
        byte[] blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(account + "\n" + password), CredentialEntropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
        string temp = path + ".tmp";
        File.WriteAllBytes(temp, blob);
        if (File.Exists(path)) File.Delete(path);
        File.Move(temp, path);
        return 0;
    }

    /** The stored account and password, or a Fail when the blob is missing or is not this user's. */
    internal static string[] CredentialRead(string path) {
        byte[] blob;
        try { blob = File.ReadAllBytes(path); } catch (Exception) { throw new Fail(EXIT_CONTAINMENT, "the sandbox account's credential is missing; run the sandbox setup"); }
        string text;
        try { text = Encoding.UTF8.GetString(ProtectedData.Unprotect(blob, CredentialEntropy, DataProtectionScope.CurrentUser)); }
        catch (Exception) { throw new Fail(EXIT_CONTAINMENT, "the sandbox account's credential cannot be opened by this user"); }
        int nl = text.IndexOf('\n');
        if (nl <= 0) throw new Fail(EXIT_CONTAINMENT, "the sandbox account's credential is damaged");
        return new string[] { text.Substring(0, nl), text.Substring(nl + 1) };
    }

    static int Main(string[] args) {
        // No error dialog, ever: a child that cannot start fails with a code, not with a window on the user's screen.
        N.SetErrorMode(0x8003);
        try {
            if (args.Length == 2 && args[0] == "--spec") {
                Spec spec = ReadSpec(args[1]);
                // The inner spec holds the command and its whole environment. Read, it is of no further use, and it
                // is removed before the command exists: a launcher that is killed leaves none behind.
                if (spec.Profile == "STAGE2") { try { File.Delete(args[1]); } catch (Exception) { } }
                return Run(spec);
            }
            if (args.Length == 3 && args[0] == "label") return Label(args[1], args[2]);
            if (args.Length == 3 && args[0] == "credential" && args[1] == "write") return CredentialWrite(args[2]);
            if (args.Length == 3 && args[0] == "credential" && args[1] == "check") { Console.Out.WriteLine(CredentialRead(args[2])[0]); return 0; }
            if (args.Length == 2 && args[0] == "pipe-protect") return PipeProtect(args[1]);
            if (args.Length == 2 && args[0] == "appcontainer-sid") { foreach (char c in args[1]) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) throw new Fail(EXIT_USAGE, "bad AppContainer name"); Console.Out.WriteLine(SidText(AppContainerSid(args[1]))); return 0; }
            if (args.Length == 2 && args[0] == "capability-sid") { foreach (char c in args[1]) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) throw new Fail(EXIT_USAGE, "bad capability name"); Console.Out.WriteLine(SidText(CapabilitySid(args[1]))); return 0; }
            if (args.Length == 2 && args[0] == "canonical") {
                // The canonical form of a path, as Windows gives it (GetFinalPathNameByHandle). Inside an AppContainer
                // this is refused unless its capability is let in to the Mount Manager device; NEXUS asks it from
                // inside the containment at every start, to know.
                IntPtr h = N.CreateFileW(args[1], 0, 7, IntPtr.Zero, 3, 0x02000000 /* FILE_FLAG_BACKUP_SEMANTICS */, IntPtr.Zero);
                if (h == IntPtr.Zero || h == new IntPtr(-1)) throw new Fail(EXIT_START, "the path could not be opened: " + Marshal.GetLastWin32Error());
                StringBuilder path = new StringBuilder(2048);
                uint n = N.GetFinalPathNameByHandleW(h, path, 2048, 0);
                int e = Marshal.GetLastWin32Error();
                N.CloseHandle(h);
                if (n == 0 || n >= 2048) throw new Fail(EXIT_START, "Windows did not give the canonical form of the path: " + e);
                Console.Out.WriteLine(path.ToString());
                return 0;
            }
            if (args.Length == 1 && args[0] == "--version") { Console.Out.WriteLine("nexus-launch 1"); return 0; }
            Err("usage: nexus-launch --spec <file> | label low|medium|protect|clear <path> | --version");
            return EXIT_USAGE;
        } catch (Fail f) {
            Err(f.Message);
            return f.Code;
        } catch (Exception e) {
            // Anything unforeseen is a failure to contain: nothing was started, or what was started dies with the job.
            Err("unexpected failure: " + e.Message);
            return EXIT_CONTAINMENT;
        }
    }
}
