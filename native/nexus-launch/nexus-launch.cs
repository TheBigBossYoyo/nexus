// nexus-launch: starts one command inside the NEXUS containment and relays its exit code.
//
// NEXUS never runs project code itself and never lets an agent's shell run it bare: the command is handed to
// this program in a spec file, and this program is the only place where the containment is made. It creates a
// job object (the whole process tree dies with the job; no child can leave it), a token with every privilege
// removed and, for the ISOLATED profile, low integrity, starts the command suspended, puts it in the job, and
// only then lets it run. If any step fails nothing runs: there is no path from here to an uncontained start.
//
// Build (C# 5, the compiler that ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /platform:x64 /target:exe
//       /out:nexus-launch.exe nexus-launch.cs
//
// Exit codes: the command's own, or 120..127 for the launcher's failures (125: the containment could not be made).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
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
    public string Report = null;
}

static class Program {
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
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
                else if (key == "report") spec.Report = B64(value);
                // An unknown key is refused: a spec this launcher does not fully understand is not run.
                else throw new Fail(EXIT_SPEC, "unknown spec key: " + key);
            } catch (Fail) { throw; } catch (Exception) { throw new Fail(EXIT_SPEC, "bad value for " + key); }
        }
        if (!version) throw new Fail(EXIT_SPEC, "the spec has no version");
        if (spec.Profile != "ISOLATED" && spec.Profile != "RESTRICTED") throw new Fail(EXIT_SPEC, "the spec names no known profile");
        if (string.IsNullOrEmpty(spec.Command)) throw new Fail(EXIT_SPEC, "the spec has no command");
        if (string.IsNullOrEmpty(spec.Cwd) || !Directory.Exists(spec.Cwd)) throw new Fail(EXIT_SPEC, "the working directory does not exist");
        if (spec.MaxProcesses < 1 || spec.MaxProcesses > 4096) throw new Fail(EXIT_SPEC, "max-processes out of range");
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

    /** A copy of this process's token with every privilege but "bypass traverse checking" removed and, for ISOLATED, low integrity. */
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
        if (spec.Profile == "ISOLATED") {
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

    static int Run(Spec spec) {
        IntPtr job = BuildJob(spec);
        IntPtr token = BuildToken(spec);
        IntPtr env = BuildEnvironment(spec);

        STARTUPINFO si = new STARTUPINFO();
        si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = StdOrNul(-10, 0x80000000);
        si.hStdOutput = StdOrNul(-11, 0x40000000);
        si.hStdError = StdOrNul(-12, 0x40000000);

        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | (spec.Window ? 0 : CREATE_NO_WINDOW);
        PROCESS_INFORMATION pi;
        StringBuilder commandLine = new StringBuilder(spec.Command);
        // Suspended: the process exists and has run nothing when it is put in the job.
        if (!N.CreateProcessAsUserW(token, null, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, env, spec.Cwd, ref si, out pi)) {
            int e = Marshal.GetLastWin32Error();
            throw new Fail(EXIT_START, "the command could not be started: " + new Win32Exception(e).Message + " (" + e + ")");
        }
        bool inJob = false;
        if (!N.AssignProcessToJobObject(job, pi.hProcess) || !N.IsProcessInJob(pi.hProcess, job, out inJob) || !inJob) {
            int e = Marshal.GetLastWin32Error();
            N.TerminateProcess(pi.hProcess, 1);
            throw new Fail(EXIT_CONTAINMENT, "the process could not be put in its job: " + e);
        }
        N.ResumeThread(pi.hThread);
        N.CloseHandle(pi.hThread);

        uint waited = N.WaitForSingleObject(pi.hProcess, spec.TimeoutMs == 0 ? 0xFFFFFFFF : spec.TimeoutMs);
        if (waited != 0) {
            N.TerminateJobObject(job, (uint)EXIT_TIMEOUT);
            WriteReport(spec, job, pi.dwProcessId, "timeout");
            return EXIT_TIMEOUT;
        }
        uint code; N.GetExitCodeProcess(pi.hProcess, out code);
        WriteReport(spec, job, pi.dwProcessId, code.ToString());
        // The command has ended: whatever it left running ends with it. A long-lived process is its own launch.
        N.TerminateJobObject(job, 0);
        N.CloseHandle(job);
        return (int)code;
    }

    /** Sets or clears the mandatory label of a directory tree: `low` makes it writable from the containment, `protect` unreadable from it, `clear` removes the label. */
    static int Label(string mode, string path) {
        if (!Directory.Exists(path) && !File.Exists(path)) throw new Fail(EXIT_SPEC, "no such path");
        string sddl = mode == "low" ? "S:(ML;OICI;NW;;;LW)" : mode == "protect" ? "S:(ML;OICI;NWNRNX;;;ME)" : mode == "clear" ? "S:" : null;
        if (sddl == null) throw new Fail(EXIT_USAGE, "label mode must be low, protect or clear");
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

    static int Main(string[] args) {
        // No error dialog, ever: a child that cannot start fails with a code, not with a window on the user's screen.
        N.SetErrorMode(0x8003);
        try {
            if (args.Length == 2 && args[0] == "--spec") return Run(ReadSpec(args[1]));
            if (args.Length == 3 && args[0] == "label") return Label(args[1], args[2]);
            if (args.Length == 1 && args[0] == "--version") { Console.Out.WriteLine("nexus-launch 1"); return 0; }
            Err("usage: nexus-launch --spec <file> | label low|protect|clear <path> | --version");
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
