// nexus-elevate: the temporary administrator broker of a NEXUS privilege session, and the relay that reaches it.
//
// NEXUS itself never runs elevated, and no agent ever holds an elevated process, token or handle. When the owner
// prepares a privilege session (one UAC prompt, while they are there), the runtime starts this program as a RELAY,
// unelevated, with its standard input and output as the only channel. The relay asks Windows to start a second copy
// of this program elevated (that is the UAC prompt) as the BROKER, connects to the one named pipe the broker made,
// and passes lines between the runtime and the broker. Nothing else can talk to the broker:
//
//   - the broker creates its pipe as the first and only instance of its name (one instance, never a second), open
//     to the user's own SID at medium integrity or above; an AppContainer, a low-integrity process, a restricted
//     token or the sandbox account is refused by Windows before the broker sees anything;
//   - it accepts exactly one client: the process whose id and start time it was given (the relay that started it,
//     the same program file as itself), and ends at once if anything else connects first;
//   - the relay checks that the pipe's server is the process Windows returned from the elevation, so the runtime
//     never talks to a process that took the pipe's name before the broker;
//   - the broker then hands the runtime a session key over that checked path, and every request after it carries a
//     sequence number (exactly one more than the last) and an HMAC-SHA256 of the session, the direction, the
//     number and the body: a replayed, reordered, forged or other session's line ends the session.
//
// The broker ends when the relay's connection ends, when the runtime's process ends, when the relay's process ends,
// when the session's time is over, or when it is told to end. Whatever it started ends with it (job objects that
// kill on close). It runs no shell for anyone: a request names an executable by its canonical path, its arguments as
// a list, its working directory and its environment, and it is refused here (whatever the runtime decided) if it
// names a capability the session was not given, an interpreter of command strings, a program or argument from the
// list that no session may ever touch, or a program outside the protected program folders whose SHA-256 was not given
// (such a program is copied into a folder only administrators can write, checked again there, and run from there).
// The processes it starts have no console window and are on a desktop of the broker's own, not on the owner's screen.
//
//   nexus-elevate.exe session --runtime-pid <pid> --session <id> --expires-unix <s> --capabilities A,B [--unelevated-test --staging <dir>]
//   nexus-elevate.exe serve ... (started by the relay only)
//   nexus-elevate.exe probe <pipe-name>     tries to open a broker's pipe and says what Windows answered (tests)
//   nexus-elevate.exe --version
//
// Lines, both ways, UTF-8:  <seq>\t<mac-hex or ->\t<json>. The broker's first line (seq 0, no MAC) is its hello with
// the key; the relay's own lines have seq "s". Requests (body): {"op":"ping"} {"op":"end"}
//   {"op":"exec","opId":"..","capability":"..","executable":"C:\\..","args":[..],"cwd":"C:\\..","env":{..},
//    "timeoutMs":300000,"sha256":"<hex of the executable when it is outside the protected program folders>",
//    "inputs":[{"arg":<index>,"sha256":"<hex>"}],   (files an argument names: a script, a package; staged and checked)
//    "files":[{"path":"C:\..","sha256":"<hex>"}]}   (files staged beside them, such as a script's companion)
// MAC = HMAC-SHA256(key, session "\n" ("q" | "r") "\n" seq "\n" json).
//
// --unelevated-test starts the broker without elevation (no UAC prompt) for the tests of the protocol; it gives
// nothing the user does not already have. The runtime never passes it.
//
// Build (C# 5, the compiler that ships with Windows; scripts\build-elevate.mjs does it):
//   csc.exe /nologo /optimize+ /platform:x64 /target:winexe /out:nexus-elevate.exe nexus-elevate.cs
// It is a window-less program (winexe): neither copy ever opens a console window.
//
// Exit codes: 0 done, 2 usage, 5 the owner declined the elevation, 6 the broker could not be started or reached,
// 7 not elevated, 8 a client other than the relay connected, 9 the session could not be verified,
// 10 the staging folder could not be made safely (it existed, is a link, or belongs to someone else),
// 11 the program's own folder or file can be modified by non-administrators, 12 unexpected files or settings
// that .NET would load beside or into the program.
//
// What the broker enforces itself (0.9.1 hardening), whatever the runtime sent:
//   - the staging folder is new, owned by Administrators, protected, never a link; leftovers of crashed sessions are removed;
//   - a staged file stays open (no write, no delete by others) from the hash check until its program has ended;
//   - each capability is a template here as well (programs, verbs, switches), stricter than or equal to the runtime's;
//   - elevated, outside the tests, it serves only from a folder that non-administrators cannot modify;
//   - what installer or service work may outlive the job is reported in the result ("leftover"), never stopped here.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
[StructLayout(LayoutKind.Sequential)]
struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
[StructLayout(LayoutKind.Sequential)]
struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
[StructLayout(LayoutKind.Sequential)]
struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
[StructLayout(LayoutKind.Sequential)]
struct SERVICE_STATUS { public uint dwServiceType, dwCurrentState, dwControlsAccepted, dwWin32ExitCode, dwServiceSpecificExitCode, dwCheckPoint, dwWaitHint; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct SHELLEXECUTEINFO { public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb; public string lpFile; public string lpParameters; public string lpDirectory; public int nShow; public IntPtr hInstApp; public IntPtr lpIDList; public string lpClass; public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hIconOrMonitor; public IntPtr hProcess; }

static class N
{
    const string K = "kernel32.dll"; const string A = "advapi32.dll";
    [DllImport(K)] public static extern uint SetErrorMode(uint m);
    [DllImport(K)] public static extern IntPtr GetCurrentProcess();
    [DllImport(K, SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport(K, SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport(K, SetLastError = true)] public static extern uint GetProcessId(IntPtr h);
    [DllImport(K, SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport(K, SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport(K, SetLastError = true)] public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
    [DllImport(K, SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport(K, SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport(K, SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);
    [DllImport(K, SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport(K, SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WaitNamedPipeW(string name, uint ms);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string f, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder path, uint length, uint flags);
    [DllImport(K, SetLastError = true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
    [DllImport(K, SetLastError = true)] public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr a, string name);
    [DllImport(K, SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport(K, SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, out int ret);
    [DllImport(K, SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport(K, SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport(K)] public static extern IntPtr LocalFree(IntPtr p);
    [DllImport(A, SetLastError = true)] public static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport(A, SetLastError = true)] public static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int ret);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr s);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, out uint size);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateDirectoryW(string path, ref SECURITY_ATTRIBUTES sa);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenMutexW(uint access, bool inherit, string name);
    [DllImport(K, SetLastError = true)] public static extern bool ReleaseMutex(IntPtr h);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport(A, SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport(A, SetLastError = true)] public static extern bool QueryServiceStatus(IntPtr service, out SERVICE_STATUS status);
    [DllImport(A, SetLastError = true)] public static extern bool CloseServiceHandle(IntPtr h);
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr sa);
}

class Refused : Exception { public Refused(string m) : base(m) { } }

static class Json
{
    public static object Parse(string s)
    {
        Reader r = new Reader(s);
        object v = r.Value(0);
        r.Skip();
        if (r.I != s.Length) throw new FormatException("unexpected characters after the value");
        return v;
    }

    class Reader
    {
        readonly string s;
        public int I;
        public Reader(string text) { s = text; }
        public void Skip() { while (I < s.Length && (s[I] == ' ' || s[I] == '\t' || s[I] == '\r' || s[I] == '\n')) I++; }
        public object Value(int depth)
        {
            if (depth > 8) throw new FormatException("nested too deeply");
            Skip();
            if (I >= s.Length) throw new FormatException("unexpected end");
            char c = s[I];
            if (c == '{') return Obj(depth);
            if (c == '[') return Arr(depth);
            if (c == '"') return Str();
            if (c == 't') return Lit("true", true);
            if (c == 'f') return Lit("false", false);
            if (c == 'n') return Lit("null", null);
            if (c == '-' || (c >= '0' && c <= '9')) return Num();
            throw new FormatException("unexpected character at " + I);
        }
        object Lit(string word, object v)
        {
            if (string.CompareOrdinal(s, I, word, 0, word.Length) != 0) throw new FormatException("bad literal at " + I);
            I += word.Length;
            return v;
        }
        object Num()
        {
            int start = I;
            if (s[I] == '-') I++;
            int digits = 0;
            while (I < s.Length && s[I] >= '0' && s[I] <= '9') { I++; digits++; }
            if (digits == 0 || digits > 15) throw new FormatException("bad number at " + start);
            return double.Parse(s.Substring(start, I - start), CultureInfo.InvariantCulture);
        }
        string Str()
        {
            I++;
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (I >= s.Length) throw new FormatException("unterminated string");
                char c = s[I++];
                if (c == '"') return sb.ToString();
                if (c < 0x20) throw new FormatException("control character in a string");
                if (c != '\\') { sb.Append(c); continue; }
                if (I >= s.Length) throw new FormatException("unterminated string");
                char e = s[I++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (I + 4 > s.Length) throw new FormatException("bad escape");
                        int code;
                        if (!int.TryParse(s.Substring(I, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new FormatException("bad escape");
                        sb.Append((char)code);
                        I += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
        }
        object Arr(int depth)
        {
            I++;
            List<object> list = new List<object>();
            Skip();
            if (I < s.Length && s[I] == ']') { I++; return list; }
            while (true)
            {
                list.Add(Value(depth + 1));
                Skip();
                if (I >= s.Length) throw new FormatException("unterminated array");
                if (s[I] == ',') { I++; continue; }
                if (s[I] == ']') { I++; return list; }
                throw new FormatException("bad array at " + I);
            }
        }
        object Obj(int depth)
        {
            I++;
            Dictionary<string, object> d = new Dictionary<string, object>();
            Skip();
            if (I < s.Length && s[I] == '}') { I++; return d; }
            while (true)
            {
                Skip();
                if (I >= s.Length || s[I] != '"') throw new FormatException("a key was expected at " + I);
                string k = Str();
                Skip();
                if (I >= s.Length || s[I] != ':') throw new FormatException("a colon was expected at " + I);
                I++;
                if (d.ContainsKey(k)) throw new FormatException("duplicate key");
                d[k] = Value(depth + 1);
                Skip();
                if (I >= s.Length) throw new FormatException("unterminated object");
                if (s[I] == ',') { I++; continue; }
                if (s[I] == '}') { I++; return d; }
                throw new FormatException("bad object at " + I);
            }
        }
    }

    public static string Quote(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary>One object: Ev("result", "opId", id, "exitCode", 0). Values: string, int, long, bool, string[] or null.</summary>
    public static string Ev(string name, params object[] kv)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"e\":").Append(Quote(name));
        for (int i = 0; i + 1 < kv.Length; i += 2)
        {
            sb.Append(',').Append(Quote((string)kv[i])).Append(':');
            object v = kv[i + 1];
            if (v == null) sb.Append("null");
            else if (v is bool) sb.Append((bool)v ? "true" : "false");
            else if (v is int || v is long || v is uint) sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
            else if (v is string[])
            {
                sb.Append('[');
                string[] a = (string[])v;
                for (int j = 0; j < a.Length; j++) { if (j > 0) sb.Append(','); sb.Append(Quote(a[j])); }
                sb.Append(']');
            }
            else sb.Append(Quote(v.ToString()));
        }
        sb.Append('}');
        return sb.ToString();
    }

    public static string Str(Dictionary<string, object> d, string key, bool required)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) { if (required) throw new Refused("\"" + key + "\" is required"); return null; }
        if (!(v is string)) throw new Refused("\"" + key + "\" must be a string");
        return (string)v;
    }
}

static class Program
{
    const uint SYNCHRONIZE = 0x00100000, PROCESS_QUERY_LIMITED = 0x1000;
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint PIPE_ACCESS_DUPLEX = 3, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000, FILE_FLAG_OVERLAPPED = 0x40000000;
    const uint PIPE_REJECT_REMOTE_CLIENTS = 8, OPEN_EXISTING = 3, SECURITY_SQOS_PRESENT = 0x00100000, SECURITY_IDENTIFICATION = 0x00010000;
    const uint WAIT_TIMEOUT = 258, INFINITE = 0xFFFFFFFF;
    const int EXIT_USAGE = 2, EXIT_DECLINED = 5, EXIT_UNREACHABLE = 6, EXIT_NOT_ELEVATED = 7, EXIT_WRONG_CLIENT = 8, EXIT_UNVERIFIED = 9;

    static readonly Regex PipeName = new Regex("^nexus-priv-[0-9a-f]{32}$");
    static readonly Regex SessionId = new Regex("^[A-Za-z0-9-]{1,64}$");
    static readonly Regex CapabilityName = new Regex("^[A-Z][A-Z_]{1,63}$");
    static readonly Regex EnvName = new Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$");
    static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$");

    static string SelfPath() { return Assembly.GetExecutingAssembly().Location; }

    static int Main(string[] args)
    {
        // No Windows error dialog may ever appear: this runs unattended, at night.
        N.SetErrorMode(0x8003);
        try
        {
            if (args.Length == 1 && args[0] == "--version") { Console.Out.WriteLine("nexus-elevate 1"); return 0; }
            if (args.Length == 2 && args[0] == "probe") return Probe(args[1]);
            if (args.Length >= 1 && args[0] == "session") return Relay(Options(args));
            if (args.Length >= 1 && args[0] == "serve") return Broker.Serve(Options(args));
        }
        catch (FormatException e) { Err(e.Message); return EXIT_USAGE; }
        Err("usage: nexus-elevate session --runtime-pid <pid> --session <id> --expires-unix <s> --capabilities A,B | probe <pipe> | --version");
        return EXIT_USAGE;
    }

    public static void Err(string s) { try { Console.Error.WriteLine("nexus-elevate: " + s); } catch (Exception) { } }

    public static Dictionary<string, string> Options(string[] args)
    {
        Dictionary<string, string> o = new Dictionary<string, string>();
        for (int i = 1; i < args.Length; i++)
        {
            string a = args[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) throw new FormatException("unexpected argument " + a);
            string key = a.Substring(2);
            if (key == "unelevated-test") { o[key] = "1"; continue; }
            if (i + 1 >= args.Length) throw new FormatException("--" + key + " needs a value");
            if (o.ContainsKey(key)) throw new FormatException("--" + key + " given twice");
            o[key] = args[++i];
        }
        return o;
    }

    public static string Need(Dictionary<string, string> o, string key, Regex shape)
    {
        string v;
        if (!o.TryGetValue(key, out v)) throw new FormatException("--" + key + " is required");
        if (shape != null && !shape.IsMatch(v)) throw new FormatException("--" + key + " is not valid");
        return v;
    }

    public static long Creation(IntPtr process)
    {
        long c, x, k, u;
        if (!N.GetProcessTimes(process, out c, out x, out k, out u)) return -1;
        return c;
    }

    public static string ImageOf(IntPtr process)
    {
        StringBuilder sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        return N.QueryFullProcessImageNameW(process, 0, sb, ref size) ? sb.ToString() : null;
    }

    /// <summary>Windows' own rules for one argument of a command line (CommandLineToArgvW).</summary>
    public static string QuoteArg(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; ; i++)
        {
            int slashes = 0;
            while (i < a.Length && a[i] == '\\') { slashes++; i++; }
            if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
            if (a[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(a[i]); }
        }
        sb.Append('"');
        return sb.ToString();
    }

    // ---------------------------------------------------------------- the relay (unelevated, started by the runtime)
    static int Relay(Dictionary<string, string> o)
    {
        string runtimePid = Need(o, "runtime-pid", new Regex("^[0-9]{1,10}$"));
        string session = Need(o, "session", SessionId);
        string expires = Need(o, "expires-unix", new Regex("^[0-9]{1,12}$"));
        string capabilities = Need(o, "capabilities", new Regex("^[A-Z_,]{2,2000}$"));
        bool test = o.ContainsKey("unelevated-test");
        string staging = test ? Need(o, "staging", null) : null;
        byte[] r = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(r);
        string pipe = "nexus-priv-" + BitConverter.ToString(r).Replace("-", "").ToLowerInvariant();
        IntPtr self = N.GetCurrentProcess();
        string parameters = "serve --pipe " + pipe + " --client-pid " + N.GetProcessId(self) + " --client-created " + Creation(self)
            + " --runtime-pid " + runtimePid + " --session " + session + " --expires-unix " + expires + " --capabilities " + capabilities
            + (test ? " --unelevated-test --staging " + QuoteArg(staging) : "");

        if (!test)
        {
            // Before the owner is asked anything: a broker that non-administrators can replace is not offered for approval.
            int why;
            string bad = Install.Check(out why);
            if (bad != null) { Say("failed", "reason", bad); return why; }
        }
        IntPtr broker;
        if (test)
        {
            STARTUPINFO si = new STARTUPINFO(); si.cb = (uint)Marshal.SizeOf(si);
            PROCESS_INFORMATION pi;
            if (!N.CreateProcessW(SelfPath(), new StringBuilder(QuoteArg(SelfPath()) + " " + parameters), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi))
            { Say("failed", "reason", "the broker could not be started: " + Marshal.GetLastWin32Error()); return EXIT_UNREACHABLE; }
            N.CloseHandle(pi.hThread);
            broker = pi.hProcess;
        }
        else
        {
            SHELLEXECUTEINFO info = new SHELLEXECUTEINFO();
            info.cbSize = Marshal.SizeOf(info);
            info.fMask = 0x40 | 0x100;   // SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
            info.lpVerb = "runas";
            info.lpFile = SelfPath();
            info.lpParameters = parameters;
            info.nShow = 0;              // SW_HIDE
            if (!N.ShellExecuteExW(ref info))
            {
                int code = Marshal.GetLastWin32Error();
                if (code == 1223) { Say("declined"); return EXIT_DECLINED; }   // ERROR_CANCELLED: the owner said no
                Say("failed", "reason", "the elevation failed: " + code);
                return EXIT_UNREACHABLE;
            }
            broker = info.hProcess;
            if (broker == IntPtr.Zero) { Say("failed", "reason", "no process came back from the elevation"); return EXIT_UNREACHABLE; }
        }
        uint brokerPid = N.GetProcessId(broker);
        string path = "\\\\.\\pipe\\" + pipe;
        IntPtr h = new IntPtr(-1);
        DateTime until = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < until)
        {
            if (N.WaitForSingleObject(broker, 0) == 0)
            {
                uint ended;
                N.GetExitCodeProcess(broker, out ended);
                Say("failed", "reason", "the broker ended before it could be reached (" + ExitMeaning(ended) + ")");
                return EXIT_UNREACHABLE;
            }
            if (N.WaitNamedPipeW(path, 250))
            {
                h = N.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, IntPtr.Zero);
                if (h != new IntPtr(-1)) break;
            }
            else Thread.Sleep(50);
        }
        if (h == new IntPtr(-1)) { N.TerminateProcess(broker, 1); Say("failed", "reason", "the broker's pipe could not be opened"); return EXIT_UNREACHABLE; }
        uint server;
        if (!N.GetNamedPipeServerProcessId(h, out server) || server != brokerPid)
        {
            // Somebody else made a pipe of that name: never talk to it.
            N.CloseHandle(h);
            N.TerminateProcess(broker, 1);
            Say("failed", "reason", "the pipe is not the broker's");
            return EXIT_UNVERIFIED;
        }
        NamedPipeClientStream stream = new NamedPipeClientStream(PipeDirection.InOut, true, true, new SafePipeHandle(h, true));
        Say("relay", "brokerPid", brokerPid, "pipe", pipe);
        Stream stdout = Console.OpenStandardOutput();
        object outLock = new object();
        Thread down = new Thread(delegate ()
        {
            try
            {
                StreamReader reader = new StreamReader(stream, new UTF8Encoding(false));
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    byte[] b = Encoding.UTF8.GetBytes(line + "\n");
                    lock (outLock) { stdout.Write(b, 0, b.Length); stdout.Flush(); }
                }
            }
            catch (Exception) { }
            Environment.Exit(0);   // the broker went away: so does the relay
        });
        down.IsBackground = true;
        down.Start();
        try
        {
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            StreamWriter up = new StreamWriter(stream, new UTF8Encoding(false));
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length > 262144) break;
                up.Write(line + "\n");
                up.Flush();
            }
        }
        catch (Exception) { }
        // The runtime closed its side (or ended): the broker loses its client and ends.
        try { stream.Dispose(); } catch (Exception) { }
        N.WaitForSingleObject(broker, 5000);
        return 0;
    }

    /// <summary>The words for the broker's exit codes: its stderr is seen by nobody when Windows starts it elevated.</summary>
    static string ExitMeaning(uint code)
    {
        switch (code)
        {
            case 7: return "code 7: not elevated";
            case 8: return "code 8: a client other than the relay connected";
            case 9: return "code 9: the session could not be verified";
            case 10: return "code 10: the staging folder could not be made safely (it existed, is a link, or belongs to someone else)";
            case 11: return "code 11: the broker is in a folder that non-administrators can modify; install NEXUS for all users";
            case 12: return "code 12: a file .NET would load (a .dll, .config, .manifest or .local) is next to the broker";
            case 13: return "code 13: the elevated environment has a COR_ variable (a .NET profiler) set";
            case 14: return "code 14: the elevated environment has a COMPlus_ variable (.NET runtime settings) set";
            case 15: return "code 15: the elevated environment has DOTNET_STARTUP_HOOKS set";
            case 16: return "code 16: the elevated environment has __COMPAT_LAYER (a Windows compatibility layer) set";
            default: return "code " + code;
        }
    }

    static void Say(string name, params object[] kv)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes("s\t-\t" + Json.Ev(name, kv) + "\n");
            Stream o = Console.OpenStandardOutput();
            o.Write(b, 0, b.Length);
            o.Flush();
        }
        catch (Exception) { }
    }

    static int Probe(string name)
    {
        if (!PipeName.IsMatch(name)) { Console.Out.WriteLine("invalid"); return EXIT_USAGE; }
        IntPtr h = N.CreateFileW("\\\\.\\pipe\\" + name, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, IntPtr.Zero);
        if (h == new IntPtr(-1)) { Console.Out.WriteLine("refused " + Marshal.GetLastWin32Error()); return 1; }
        // Opened: say so, then wait to see whether the broker keeps it (it never does for anything but its relay).
        Console.Out.WriteLine("opened");
        Console.Out.Flush();
        byte[] b = new byte[1];
        try
        {
            using (FileStream f = new FileStream(new SafeFileHandle(h, true), FileAccess.ReadWrite, 1, false))
            {
                int n = f.Read(b, 0, 1);
                Console.Out.WriteLine(n == 0 ? "closed-by-broker" : "received");
            }
        }
        catch (IOException) { Console.Out.WriteLine("closed-by-broker"); }
        return 0;
    }
}

/// <summary>What an operation may leave behind outside its job: Windows Installer work, a service's state.</summary>
sealed class Watch
{
    public bool Msi;
    public string Service;
    public string Verb;
}

/// <summary>
/// The capability templates, hard-coded here: a minimal subset of src/main/modules/privilege/policy.ts (template()),
/// equal or stricter. They know nothing of the run's worktrees or the role of the requester (the runtime decides those);
/// they bound what a request can be if it reached the broker without passing the runtime's policy. A capability this does
/// not know is refused. The same file names, verbs, switches and shapes as the runtime; stricter in: PowerShell is the
/// system's only (never pwsh), a result or log file is a plain local path outside the Windows and Program Files folders,
/// no extra spaces around a service name, a firewall or registry argument has a plain character set only.
/// </summary>
static class Templates
{
    static readonly string Win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    static readonly string[] PsHead = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File" };
    static readonly HashSet<string> SilentFlags = new HashSet<string>(StringComparer.Ordinal) {
        "/s", "/q", "/qn", "/quiet", "/passive", "/silent", "/verysilent", "/norestart", "/suppressmsgboxes", "/sp-", "--silent", "--quiet", "--norestart",
        "-s", "-q", "/install", "/uninstall", "/repair", "/currentuser", "/allusers" };
    static readonly HashSet<string> SilentRequired = new HashSet<string>(StringComparer.Ordinal) { "/s", "/q", "/qn", "/quiet", "/passive", "/silent", "/verysilent", "--silent", "--quiet", "-s", "-q" };
    static readonly HashSet<string> ProtectedServices = new HashSet<string>(StringComparer.Ordinal) {
        "windefend", "wdnissvc", "wdfilter", "sense", "securityhealthservice", "wscsvc", "mpssvc", "bfe", "eventlog", "trustedinstaller", "lsm", "samss", "vaultsvc", "keyiso",
        "cryptsvc", "appidsvc", "gpsvc", "lanmanserver", "lanmanworkstation", "termservice", "winrm", "remoteregistry", "vsserv", "bdredline", "bdservicehost", "updatesrv",
        "wuauserv", "bits", "dhcp", "dnscache", "nsi", "rpcss", "rpceptmapper", "schedule", "seclogon", "sppsvc", "usosvc", "winmgmt", "wlansvc", "netlogon", "efs" };
    static readonly Regex PlainValue = new Regex(@"^[A-Za-z0-9_.:\\ {}-]{1,260}$");
    static readonly Regex LocalPath = new Regex(@"^[A-Za-z]:\\[A-Za-z0-9_.\\ -]{1,250}$");

    static string Sys(string n) { return Path.Combine(Win, "System32", n); }
    static bool Is(string exe, string n) { return string.Equals(exe, Sys(n), StringComparison.OrdinalIgnoreCase); }
    static string Low(string s) { return s.ToLowerInvariant(); }
    static Refused No(string why) { return new Refused(why); }

    public static Watch Check(string capability, string exe, List<string> args, HashSet<int> inputs, string staging)
    {
        Watch w = new Watch();
        string name = Path.GetFileName(exe).ToLowerInvariant();
        switch (capability)
        {
            case "NEXUS_SANDBOX_REPAIR":
            case "NEXUS_SCHEDULED_TASK_REPAIR":
                Script(exe, args, inputs, new string[] { "setup-sandbox.ps1" }, new string[] { "MainUserSid", "PasswordFile", "ResultFile" }, new string[0], "ResultFile");
                return w;
            case "NEXUS_CANONICALIZATION_REPAIR":
                Script(exe, args, inputs, new string[] { "restore-canonicalization.ps1" }, new string[] { "ResultFile" }, new string[] { "Check" }, "ResultFile");
                return w;
            case "PROJECT_TOOLCHAIN_INSTALL":
            case "KNOWN_DEPENDENCY_MACHINE_INSTALL":
                Installer(exe, args, inputs, new string[] { "/i" }, w);
                return w;
            case "APP_INSTALL_TEST":
                Installer(exe, args, inputs, new string[] { "/i" }, w);
                return w;
            case "PROJECT_TOOLCHAIN_REPAIR":
                if (name == "powershell.exe" || name == "pwsh.exe")
                {
                    if (!Is(exe, "WindowsPowerShell\\v1.0\\powershell.exe")) throw No("The system PowerShell only.");
                    Head(args);
                    if (!args[5].EndsWith(".ps1", StringComparison.OrdinalIgnoreCase) || !inputs.Contains(5)) throw No("A repair script must be a .ps1 given with its SHA-256.");
                    if (args.Count > 14) throw No("A repair script takes at most 8 parameters.");
                    for (int i = 6; i < args.Count; i++) if (!PlainValue.IsMatch(args[i]) || args[i].Contains("..")) throw No("A parameter of a repair script has characters it never uses.");
                    return w;
                }
                Installer(exe, args, inputs, new string[] { "/fa", "/fomus", "/fvomus", "/f" }, w);
                return w;
            case "APP_UNINSTALL_TEST":
                if (Is(exe, "msiexec.exe")) { Installer(exe, args, inputs, new string[] { "/x" }, w); return w; }
                if (!(Broker.Under(exe, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)) || Broker.Under(exe, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)))
                    || !Regex.IsMatch(Path.GetFileName(exe), @"^(uninst|uninstall)[^\\]*\.exe$", RegexOptions.IgnoreCase))
                    throw No("An uninstall runs the application's own uninstaller under Program Files, or msiexec /x.");
                InstallerArgs(args, 0);
                return w;
            case "PROJECT_SERVICE_CONTROL":
                {
                    if (!Is(exe, "sc.exe")) throw No("Services are controlled with the system sc.exe only.");
                    string verb = args.Count > 0 ? Low(args[0]) : "";
                    if (args.Count != 2 || !(verb == "query" || verb == "queryex" || verb == "start" || verb == "stop" || verb == "qc")) throw No("sc.exe is allowed with query, queryex, qc, start or stop and a service name, nothing else.");
                    if (!Regex.IsMatch(args[1], "^[A-Za-z0-9_.-]{1,80}$")) throw No("The service name is not valid.");
                    if (ProtectedServices.Contains(Low(args[1]))) throw No(args[1] + " is a Windows or security service: never controlled by a privilege session.");
                    if (verb == "start" || verb == "stop") { w.Service = args[1]; w.Verb = verb; }
                    return w;
                }
            case "NEXUS_FIREWALL_RECONCILIATION":
                {
                    if (!Is(exe, "netsh.exe")) throw No("Firewall rules are reconciled with the system netsh.exe only.");
                    List<string> a = args.ConvertAll(Low);
                    if (a.Count < 5 || a[0] != "advfirewall" || a[1] != "firewall" || !(a[2] == "add" || a[2] == "delete" || a[2] == "show") || a[3] != "rule") throw No("netsh is allowed with advfirewall firewall add|delete|show rule only.");
                    foreach (string x in args) if (!Regex.IsMatch(x, @"^[A-Za-z0-9 _.=,:/\\-]{1,200}$")) throw No("A firewall argument has characters NEXUS's rules never use.");
                    string nameArg = args.Find(delegate (string x) { return x.StartsWith("name=", StringComparison.OrdinalIgnoreCase); });
                    if (nameArg == null || !Regex.IsMatch(nameArg, "^name=NexusSandbox[A-Za-z0-9 _.-]{0,80}$", RegexOptions.IgnoreCase)) throw No("Only NEXUS's own rules (named NexusSandbox) are reconciled.");
                    if (a[2] == "add" && !a.Contains("action=block")) throw No("NEXUS's rules block; a rule that allows is never added by a privilege session.");
                    return w;
                }
            case "SIGNED_DRIVER_QUERY":
                {
                    if (!Is(exe, "driverquery.exe")) throw No("Drivers are queried with the system driverquery.exe only.");
                    HashSet<string> allowed = new HashSet<string> { "/si", "/v", "/fo", "csv", "list", "table", "/nh" };
                    foreach (string x in args) if (!allowed.Contains(Low(x))) throw No("driverquery is allowed with /si /v /fo csv|list|table /nh only.");
                    return w;
                }
            case "NEXUS_ACCEPTANCE_FIXTURE":
                if (Is(exe, "reg.exe")) { Reg(args); return w; }
                Script(exe, args, inputs, new string[] { "fixture-install.ps1", "fixture-repair.ps1", "fixture-remove.ps1" }, new string[] { "Version", "ResultFile" }, new string[0], "ResultFile");
                return w;
            default:
                throw No("The broker knows no template for the capability " + capability + ".");
        }
    }

    static void Head(List<string> args)
    {
        if (args.Count < 6) throw No("PowerShell runs only as -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>.");
        for (int i = 0; i < PsHead.Length; i++) if (!string.Equals(args[i], PsHead[i], StringComparison.OrdinalIgnoreCase)) throw No("PowerShell runs only as -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>.");
    }

    /// <summary>A script NEXUS ships: system PowerShell, the fixed head, a script of that name given as a staged input, its parameters.</summary>
    static void Script(string exe, List<string> args, HashSet<int> inputs, string[] scripts, string[] valueParams, string[] switchParams, string resultParam)
    {
        if (!Is(exe, "WindowsPowerShell\\v1.0\\powershell.exe")) throw No("This capability runs the system PowerShell only.");
        Head(args);
        string file = Path.GetFileName(args[5]);
        if (Array.FindIndex(scripts, delegate (string s) { return string.Equals(s, file, StringComparison.OrdinalIgnoreCase); }) < 0) throw No("Only " + string.Join(", ", scripts) + " may be run for this capability.");
        if (!inputs.Contains(5)) throw No("The script must be staged with its SHA-256.");
        for (int i = 6; i < args.Count; i++)
        {
            string a = args[i];
            if (!a.StartsWith("-", StringComparison.Ordinal)) throw No("The parameter " + a + " is not one this script takes here.");
            string p = a.Substring(1);
            string v = Array.Find(valueParams, delegate (string s) { return string.Equals(s, p, StringComparison.OrdinalIgnoreCase); });
            string sw = Array.Find(switchParams, delegate (string s) { return string.Equals(s, p, StringComparison.OrdinalIgnoreCase); });
            if (v == null && sw == null) throw No("The parameter " + a + " is not one this script takes here.");
            if (v == null) continue;
            if (++i >= args.Count) throw No("A parameter has no value.");
            if (!PlainValue.IsMatch(args[i]) || args[i].Contains("..")) throw No("The value of " + a + " has characters this script never takes.");
            if (string.Equals(v, resultParam, StringComparison.OrdinalIgnoreCase)) OutFile(args[i], null);
        }
    }

    /// <summary>A file the elevated program is asked to write (a result, a log): a plain local path, not under the Windows or Program Files folders.</summary>
    static void OutFile(string path, string extension)
    {
        if (!LocalPath.IsMatch(path) || path.Contains("..") || path.Contains("\\\\") || (extension != null && !path.EndsWith(extension, StringComparison.OrdinalIgnoreCase)))
            throw No("A file to write must be a plain local path" + (extension == null ? "" : " ending in " + extension) + ".");
        if (Broker.Under(path, Win) || Broker.Under(path, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)) || Broker.Under(path, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86))
            || Broker.Under(path, Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData) + "\\NexusPrivilege"))
            throw No("An elevated program does not write into the Windows or Program Files folders.");
    }

    static void InstallerArgs(List<string> args, int from)
    {
        bool silent = false;
        for (int i = from; i < args.Count; i++)
        {
            string a = Low(args[i]);
            if (SilentRequired.Contains(a)) silent = true;
            if (SilentFlags.Contains(a)) continue;
            if (Regex.IsMatch(a, @"^/l\*?v?$"))
            {
                if (++i >= args.Count) throw No("A log flag has no file.");
                OutFile(args[i], ".log");
                continue;
            }
            throw No("The installer argument " + a + " is not one of the silent-installation flags.");
        }
        if (!silent) throw No("An installer runs only silently (/S, /quiet, /qn, /silent or the like).");
    }

    static void Installer(string exe, List<string> args, HashSet<int> inputs, string[] verbs, Watch w)
    {
        if (Is(exe, "msiexec.exe"))
        {
            string verb = args.Count > 0 ? Low(args[0]) : "";
            if (Array.IndexOf(verbs, verb) < 0) throw No("msiexec is allowed here only with " + string.Join(" or ", verbs) + ".");
            string pkg = args.Count > 1 ? args[1] : "";
            bool product = Regex.IsMatch(pkg, @"^\{[0-9a-fA-F-]{36}\}$");
            if (!product)
            {
                if (!pkg.EndsWith(".msi", StringComparison.OrdinalIgnoreCase) || !inputs.Contains(1)) throw No("The package must be a .msi file given with its SHA-256.");
            }
            else if (verb == "/i") throw No("An installation names its package file, not a product code.");
            InstallerArgs(args, 2);
            w.Msi = true;
            return;
        }
        if (Broker.ProtectedProgram(exe)) throw No("An installer here is msiexec or a hashed installer program.");
        if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw No("The installer must be an .exe or a .msi.");
        InstallerArgs(args, 0);
    }

    static void Reg(List<string> args)
    {
        string verb = args.Count > 0 ? Low(args[0]) : "";
        if (!(verb == "add" || verb == "delete" || verb == "query")) throw No("reg.exe is allowed with add, delete or query here.");
        if (args.Count < 2 || !Regex.IsMatch(args[1], @"^HKLM\\SOFTWARE\\NexusAcceptanceFixture(\\[A-Za-z0-9_.-]{1,60}){0,3}$", RegexOptions.IgnoreCase)) throw No("The fixture touches HKLM\\SOFTWARE\\NexusAcceptanceFixture only.");
        for (int i = 2; i < args.Count; i++)
        {
            string f = Low(args[i]);
            if (!(f == "/v" || f == "/t" || f == "/d" || f == "/f" || f == "/ve" || f == "/s")) throw No("The reg.exe argument " + args[i] + " is not allowed here.");
            if (f == "/v" || f == "/t" || f == "/d")
            {
                string value = ++i < args.Count ? args[i] : "";
                if (!Regex.IsMatch(value, @"^[A-Za-z0-9_. :-]{0,200}$")) throw No("A fixture value has characters the fixture never uses.");
                if (f == "/t" && !(Low(value) == "reg_sz" || Low(value) == "reg_dword")) throw No("The fixture writes REG_SZ or REG_DWORD only.");
            }
        }
    }
}

/// <summary>
/// Is this program where only administrators can change it? Run by the relay before the elevation is requested and by
/// the broker again once elevated (never in --unelevated-test). If a user process can replace the file or the folder,
/// the consent prompt would elevate whatever that process put there.
/// Checked: the program file and its folder (owner Administrators, SYSTEM or TrustedInstaller; no allowing entry that
/// gives write data, append, extended attributes, delete-child, attributes, delete, change-permissions, take-ownership
/// or generic write/all to Users, Authenticated Users, Everyone, INTERACTIVE, Power Users or the current user), every
/// ancestor folder (no such entry giving delete-child, change-permissions, take-ownership or generic all), no link in
/// the path; beside the program no nexus-elevate.exe.config, nexus-elevate.exe.manifest, nexus-elevate.exe.local,
/// nexus-elevate.config and no *.dll; and in the environment no COR_*, COMPlus_*, DOTNET_STARTUP_HOOKS or __COMPAT_LAYER.
/// A config file is read before this code runs, so this is detection; the protection is the install folder.
/// </summary>
static class Install
{
    const int Writeish = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    const int AncestorWriteish = 0x40 | 0x40000 | 0x80000 | 0x10000000;
    static readonly SecurityIdentifier[] Owners = {
        new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544"),
        new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464") };
    static readonly SecurityIdentifier[] Everyone = {
        new SecurityIdentifier("S-1-5-32-545"), new SecurityIdentifier("S-1-5-11"), new SecurityIdentifier("S-1-1-0"),
        new SecurityIdentifier("S-1-5-4"), new SecurityIdentifier("S-1-5-32-547") };

    const string Folder = "The privilege broker is in a folder that non-administrators can modify; install NEXUS for all users";

    public static string Check(out int code)
    {
        code = 11;
        string self = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(self);
        SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
        try
        {
            if (!string.Equals(Broker.FinalPath(self, false), self, StringComparison.OrdinalIgnoreCase) || !string.Equals(Broker.FinalPath(dir, true), dir, StringComparison.OrdinalIgnoreCase))
                return Folder + " (the path goes through a link or a short name)";
            string bad = Weak(self, false, me, Writeish, true) ?? Weak(dir, true, me, Writeish, true);
            for (string up = Path.GetDirectoryName(dir); bad == null && up != null; up = Path.GetDirectoryName(up)) bad = Weak(up, true, me, AncestorWriteish, false);
            if (bad != null) return Folder + " (" + bad + ")";
        }
        catch (Exception e) { return Folder + " (it could not be checked: " + e.GetType().Name + ")"; }

        code = 12;
        string exe = Path.GetFileName(self);
        foreach (string entry in Directory.GetFileSystemEntries(dir))
        {
            string name = Path.GetFileName(entry);
            if (name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || string.Equals(name, exe + ".config", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, exe + ".manifest", StringComparison.OrdinalIgnoreCase) || string.Equals(name, exe + ".local", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, Path.GetFileNameWithoutExtension(exe) + ".config", StringComparison.OrdinalIgnoreCase))
                return "The privilege broker refuses to serve: " + name + " is next to it and .NET would load it";
        }
        // One exit code per cause (13 to 16): the relay is told only the elevated broker's exit code.
        foreach (System.Collections.DictionaryEntry v in Environment.GetEnvironmentVariables())
        {
            string k = ((string)v.Key).ToUpperInvariant();
            // __COMPAT_LAYER names built-in Windows compatibility layers, and Windows sets it itself on the elevated broker
            // (measured on the owner's machine: refused as code 16 on every session). Layers of elevation and display are
            // accepted; any other value is still refused. What loads code into .NET (COR_, COMPlus_, startup hooks) is never.
            int cause = k.StartsWith("COR_", StringComparison.Ordinal) ? 13 : k.StartsWith("COMPLUS_", StringComparison.Ordinal) ? 14 : k == "DOTNET_STARTUP_HOOKS" ? 15 : k == "__COMPAT_LAYER" && !BenignLayers(v.Value as string) ? 16 : 0;
            if (cause == 0) continue;
            code = cause;
            return "The privilege broker refuses to serve: the environment variable " + v.Key + " would change what .NET loads";
        }
        code = 0;
        return null;
    }

    static readonly HashSet<string> Layers = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "~", "RunAsAdmin", "RunAsHighest", "RunAsInvoker", "ElevateCreateProcess", "Installer",
        "HighDpiAware", "DpiUnaware", "GdiDpiScaling", "PerProcessSystemDpiForceOff", "PerProcessSystemDpiForceOn" };

    /// <summary>A compatibility layer value made only of layers of elevation and display (none of them loads code).</summary>
    public static bool BenignLayers(string value)
    {
        if (value == null) return true;
        foreach (string layer in value.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            if (!Layers.Contains(layer)) return false;
        return true;
    }

    static string Weak(string path, bool directory, SecurityIdentifier me, int mask, bool owner)
    {
        FileSystemSecurity sec = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        if (owner)
        {
            SecurityIdentifier o = sec.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            bool known = false;
            foreach (SecurityIdentifier s in Owners) if (s.Equals(o)) known = true;
            if (!known) return path + " is owned by " + (o == null ? "nobody known" : o.Value);
        }
        foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (r.AccessControlType != AccessControlType.Allow) continue;
            if (directory && (r.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            SecurityIdentifier who = (SecurityIdentifier)r.IdentityReference;
            bool weak = who.Equals(me);
            foreach (SecurityIdentifier s in Everyone) if (s.Equals(who)) weak = true;
            if (weak && ((int)r.FileSystemRights & mask) != 0) return who.Value + " may write " + path;
        }
        return null;
    }
}

/// <summary>The elevated side. One client, one session, then it ends.</summary>
static class Broker
{
    const uint SYNCHRONIZE = 0x00100000, PROCESS_QUERY_LIMITED = 0x1000;
    static string session;
    static byte[] key;
    static HashSet<string> capabilities = new HashSet<string>(StringComparer.Ordinal);
    static NamedPipeServerStream pipe;
    static readonly object writeLock = new object();
    static long sentSeq;
    static long lastSeq;
    static int badLines;
    static string staging;
    static string desktop;
    static readonly List<IntPtr> jobs = new List<IntPtr>();
    static volatile bool ending;

    public static int Serve(Dictionary<string, string> o)
    {
        string pipeName = Program.Need(o, "pipe", new Regex("^nexus-priv-[0-9a-f]{32}$"));
        uint clientPid = uint.Parse(Program.Need(o, "client-pid", new Regex("^[0-9]{1,10}$")), CultureInfo.InvariantCulture);
        long clientCreated = long.Parse(Program.Need(o, "client-created", new Regex("^[0-9]{1,20}$")), CultureInfo.InvariantCulture);
        uint runtimePid = uint.Parse(Program.Need(o, "runtime-pid", new Regex("^[0-9]{1,10}$")), CultureInfo.InvariantCulture);
        session = Program.Need(o, "session", new Regex("^[A-Za-z0-9-]{1,64}$"));
        long expiresUnix = long.Parse(Program.Need(o, "expires-unix", new Regex("^[0-9]{1,12}$")), CultureInfo.InvariantCulture);
        foreach (string c in Program.Need(o, "capabilities", null).Split(','))
        {
            if (!new Regex("^[A-Z][A-Z_]{1,63}$").IsMatch(c)) throw new FormatException("a capability name is not valid");
            capabilities.Add(c);
        }
        bool test = o.ContainsKey("unelevated-test");
        bool elevated = IsElevated();
        if (!elevated && !test) return 7;
        if (elevated && !test)
        {
            int why;
            string bad = Install.Check(out why);
            if (bad != null) { Program.Err(bad); return why; }
        }

        // The relay: the process given, still the one that was started then, and this very program.
        IntPtr client = N.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED, false, clientPid);
        if (client == IntPtr.Zero || Program.Creation(client) != clientCreated || !SameFile(Program.ImageOf(client), Program.ImageOf(N.GetCurrentProcess()))) return 9;
        IntPtr runtime = N.OpenProcess(SYNCHRONIZE, false, runtimePid);
        if (runtime == IntPtr.Zero) return 9;

        staging = test ? Path.GetFullPath(Program.Need(o, "staging", null)) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NexusPrivilege", session);
        try { PrepareStaging(test); }
        catch (Refused e) { Program.Err("the staging folder is refused: " + e.Message); return 10; }
        catch (Exception e) { Program.Err("the staging folder could not be made: " + e.GetType().Name + " " + e.Message); return 10; }
        desktop = "nexus-priv-" + session.ToLowerInvariant().Replace("-", "").Substring(0, Math.Min(24, session.Replace("-", "").Length));

        string user = UserSid();
        IntPtr sd; uint size;
        // The user's own SID, read and write, at medium integrity or above. No ACE for an AppContainer, a capability,
        // the sandbox account or anyone else: Windows refuses them.
        if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;0x12019f;;;" + user + ")S:(ML;;NW;;;ME)", 1, out sd, out size)) return 6;
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa); sa.lpSecurityDescriptor = sd;
        IntPtr h = N.CreateNamedPipeW("\\\\.\\pipe\\" + pipeName, 3 | 0x00080000 | 0x40000000, 8, 1, 65536, 65536, 0, ref sa);
        N.LocalFree(sd);
        if (h == new IntPtr(-1)) return 6;   // the name exists already: somebody took it, and the relay will not find us
        pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(h, true));

        // Waits for the relay, at most a minute, and not past the runtime's or the relay's end.
        ManualResetEvent connected = new ManualResetEvent(false);
        IAsyncResult wait = pipe.BeginWaitForConnection(delegate (IAsyncResult ar) { connected.Set(); }, null);
        IntPtr[] watch = new IntPtr[] { runtime, client, connected.SafeWaitHandle.DangerousGetHandle() };
        uint w = N.WaitForMultipleObjects(3, watch, false, 60000);
        if (w != 2) return 6;
        try { pipe.EndWaitForConnection(wait); } catch (Exception) { return 6; }
        uint actual;
        if (!N.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out actual) || actual != clientPid)
        {
            // Not the relay. Nobody gets a second try: the session ends here.
            try { pipe.Dispose(); } catch (Exception) { }
            return 8;
        }

        key = new byte[32];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(key);
        string[] caps = new string[capabilities.Count]; capabilities.CopyTo(caps);
        WriteRaw("0\t-\t" + Json.Ev("hello", "session", session, "key", Convert.ToBase64String(key), "elevated", elevated, "pid", (long)N.GetProcessId(N.GetCurrentProcess()), "capabilities", caps, "expiresUnix", expiresUnix, "version", "1"));

        // The watchdog: the runtime, the relay, the session's end.
        long remainingMs = (expiresUnix - (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds) * 1000;
        if (remainingMs <= 0) { End("expired"); return 0; }
        Thread dog = new Thread(delegate ()
        {
            uint r = N.WaitForMultipleObjects(2, new IntPtr[] { runtime, client }, false, (uint)Math.Min(remainingMs, 0x7FFFFFFF));
            End(r == 0 ? "runtime-ended" : r == 1 ? "relay-ended" : "expired");
        });
        dog.IsBackground = true;
        dog.Start();

        try
        {
            StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false));
            string line;
            while (!ending && (line = reader.ReadLine()) != null)
            {
                if (line.Length > 262144) { End("oversized"); break; }
                Handle(line);
            }
        }
        catch (Exception) { }
        End("disconnected");
        return 0;
    }

    static bool SameFile(string a, string b) { return a != null && b != null && string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }

    static bool IsElevated()
    {
        IntPtr token;
        if (!N.OpenProcessToken(N.GetCurrentProcess(), 0x8, out token)) return false;
        IntPtr b = Marshal.AllocHGlobal(4);
        try
        {
            int ret;
            return N.GetTokenInformation(token, 20, b, 4, out ret) && Marshal.ReadInt32(b) != 0;   // TokenElevation
        }
        finally { Marshal.FreeHGlobal(b); N.CloseHandle(token); }
    }

    static string UserSid()
    {
        IntPtr token;
        if (!N.OpenProcessToken(N.GetCurrentProcess(), 0x8, out token)) throw new FormatException("the token could not be read");
        IntPtr b = Marshal.AllocHGlobal(512);
        try
        {
            int ret;
            if (!N.GetTokenInformation(token, 1, b, 512, out ret)) throw new FormatException("the user could not be read");   // TokenUser
            IntPtr s;
            if (!N.ConvertSidToStringSidW(Marshal.ReadIntPtr(b), out s)) throw new FormatException("the user could not be read");
            string sid = Marshal.PtrToStringUni(s);
            N.LocalFree(s);
            return sid;
        }
        finally { Marshal.FreeHGlobal(b); N.CloseHandle(token); }
    }

    // Owner Administrators, no inheritance, full control for SYSTEM and Administrators only.
    const string StagingSddl = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    const string StagingDacl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    static readonly SecurityIdentifier SidSystem = new SecurityIdentifier("S-1-5-18");
    static readonly SecurityIdentifier SidAdmins = new SecurityIdentifier("S-1-5-32-544");
    static FileStream liveLock;

    /// <summary>Makes a folder that must not exist yet (ERROR_ALREADY_EXISTS otherwise), with the owner and DACL in the same call. 0 when made.</summary>
    static int CreateNew(string path, string sddl)
    {
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa);
        IntPtr sd = IntPtr.Zero;
        if (sddl != null)
        {
            uint size;
            if (!N.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) throw new Refused("the security descriptor of the staging folder could not be made");
            sa.lpSecurityDescriptor = sd;
        }
        try { return N.CreateDirectoryW(path, ref sa) ? 0 : Marshal.GetLastWin32Error(); }
        finally { if (sd != IntPtr.Zero) N.LocalFree(sd); }
    }

    static bool IsLink(string path) { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }

    static SecurityIdentifier OwnerOf(string path) { return Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier; }

    /// <summary>A folder the broker relies on: not a link, not reached through one, owned by SYSTEM or Administrators (only Administrators for a session's own).</summary>
    static void CheckFolder(string path, bool session)
    {
        if (IsLink(path)) throw new Refused(path + " is a link (reparse point)");
        if (!string.Equals(FinalPath(path, true), path, StringComparison.OrdinalIgnoreCase)) throw new Refused(path + " is reached through a link");
        SecurityIdentifier owner = OwnerOf(path);
        if (owner == null || !(owner.Equals(SidAdmins) || (!session && owner.Equals(SidSystem))))
            throw new Refused(path + " is owned by " + (owner == null ? "nobody known" : owner.Value) + ", not by " + (session ? "Administrators" : "SYSTEM or Administrators") + "; remove it as an administrator");
    }

    static void PrepareStaging(bool test)
    {
        string parent = Path.GetDirectoryName(staging);
        if (test)
        {
            // The tests' folder: its parent is theirs; the folder itself must be new, and not a link.
            if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
            int t = CreateNew(staging, null);
            if (t != 0) throw new Refused(t == 183 ? staging + " exists already" : "error " + t);
            if (IsLink(staging)) throw new Refused(staging + " is a link");
            liveLock = new FileStream(Path.Combine(staging, ".live"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            return;
        }
        // %ProgramData%\NexusPrivilege: made here with the protected DACL and Administrators as owner if absent; if present, it
        // must be no link and owned by SYSTEM or Administrators (anything else is refused, not repaired); its DACL is then reset.
        int p = CreateNew(parent, StagingSddl);
        if (p != 0 && p != 183) throw new Refused(parent + " could not be made: error " + p);
        CheckFolder(parent, false);
        if (p == 183)
        {
            System.Security.AccessControl.DirectorySecurity dacl = new System.Security.AccessControl.DirectorySecurity();
            dacl.SetSecurityDescriptorSddlForm(StagingDacl, AccessControlSections.Access);
            Directory.SetAccessControl(parent, dacl);
            CheckFolder(parent, false);
        }
        // The session's folder must not exist (a user process may have made it to own it), then it is checked as made.
        int s = CreateNew(staging, StagingSddl);
        if (s != 0) throw new Refused(s == 183 ? staging + " exists already" : staging + " could not be made: error " + s);
        CheckFolder(staging, true);
        liveLock = new FileStream(Path.Combine(staging, ".live"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        // What a crashed session left: folders of the parent that are no link, belong to SYSTEM or Administrators and are not held by a live session.
        foreach (string d in Directory.GetDirectories(parent))
        {
            if (string.Equals(d, staging, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                if (IsLink(d)) continue;
                SecurityIdentifier owner = OwnerOf(d);
                if (owner == null || !(owner.Equals(SidAdmins) || owner.Equals(SidSystem))) continue;
                string live = Path.Combine(d, ".live");
                if (File.Exists(live))
                {
                    try { using (new FileStream(live, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
                    catch (IOException) { continue; }   // a running session holds it
                }
                SafeDelete(d);
            }
            catch (Exception) { }
        }
    }

    /// <summary>Deletes a folder and what is in it; a link is removed itself and never followed.</summary>
    static void SafeDelete(string dir)
    {
        if (IsLink(dir)) { Directory.Delete(dir, false); return; }
        foreach (string entry in Directory.GetFileSystemEntries(dir))
        {
            FileAttributes a = File.GetAttributes(entry);
            bool folder = (a & FileAttributes.Directory) != 0;
            if ((a & FileAttributes.ReparsePoint) != 0)
            {
                if (folder) Directory.Delete(entry, false);
                else { if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(entry, FileAttributes.Normal); File.Delete(entry); }
            }
            else if (folder) SafeDelete(entry);
            else { if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(entry, FileAttributes.Normal); File.Delete(entry); }
        }
        Directory.Delete(dir, false);
    }

    static void WriteRaw(string line)
    {
        lock (writeLock)
        {
            byte[] b = Encoding.UTF8.GetBytes(line + "\n");
            pipe.Write(b, 0, b.Length);
            pipe.Flush();
        }
    }

    static string Mac(string direction, string seq, string body)
    {
        using (HMACSHA256 h = new HMACSHA256(key))
        {
            byte[] m = h.ComputeHash(Encoding.UTF8.GetBytes(session + "\n" + direction + "\n" + seq + "\n" + body));
            return BitConverter.ToString(m).Replace("-", "").ToLowerInvariant();
        }
    }

    static bool SameMac(string a, string b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        int d = 0;
        for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
        return d == 0;
    }

    static void Reply(string body)
    {
        lock (writeLock)
        {
            long seq = ++sentSeq;
            string s = seq.ToString(CultureInfo.InvariantCulture);
            WriteRaw(s + "\t" + Mac("r", s, body) + "\t" + body);
        }
    }

    static void Handle(string line)
    {
        string[] parts = line.Split(new char[] { '\t' }, 3);
        long seq;
        if (parts.Length != 3 || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out seq) || !SameMac(parts[1], Mac("q", parts[0], parts[2])))
        {
            Reply(Json.Ev("rejected", "reason", "the line is not authentic"));
            if (++badLines >= 3) End("unauthentic");
            return;
        }
        if (seq != lastSeq + 1)
        {
            Reply(Json.Ev("rejected", "reason", "the sequence number is not the next one"));
            if (++badLines >= 3) End("replay");
            return;
        }
        lastSeq = seq;
        Dictionary<string, object> body;
        try
        {
            body = Json.Parse(parts[2]) as Dictionary<string, object>;
            if (body == null) throw new FormatException("not an object");
        }
        catch (FormatException e) { Reply(Json.Ev("rejected", "reason", e.Message)); return; }
        string op = null;
        try
        {
            op = Json.Str(body, "op", true);
            if (op == "ping") { Reply(Json.Ev("pong")); return; }
            if (op == "end") { Reply(Json.Ev("ending")); End("ended"); return; }
            if (op == "exec") { Reply(Exec(body)); return; }
            Reply(Json.Ev("rejected", "reason", "unknown operation"));
        }
        catch (Refused e) { Reply(Json.Ev("refused", "opId", OpId(body), "reason", e.Message)); }
        catch (Exception e) { Reply(Json.Ev("refused", "opId", OpId(body), "reason", "the broker failed: " + e.GetType().Name)); }
    }

    static string OpId(Dictionary<string, object> body)
    {
        object v;
        return body.TryGetValue("opId", out v) && v is string && ((string)v).Length <= 80 ? (string)v : null;
    }

    public static void End(string why)
    {
        lock (jobs)
        {
            if (ending) return;
            ending = true;
            foreach (IntPtr j in jobs) N.TerminateJobObject(j, 1);
        }
        string outliving = null;
        try { outliving = SessionLeftover(); } catch (Exception) { }
        try { Reply(Json.Ev("ended", "reason", why, "leftover", outliving)); } catch (Exception) { }
        try { pipe.Dispose(); } catch (Exception) { }
        // Nothing of the session stays: the staged copies go with it (links inside are removed, never followed).
        try { if (liveLock != null) liveLock.Dispose(); } catch (Exception) { }
        for (int i = 0; i < 10 && staging != null && Directory.Exists(staging); i++)
        {
            try { SafeDelete(staging); } catch (Exception) { Thread.Sleep(200); }
        }
        Environment.Exit(0);
    }

    // ---------------------------------------------------------------- what may be run, decided here as well

    /// <summary>Programs no privilege session runs, whatever was approved: interpreters of command strings, boot, disks,
    /// accounts, credentials, shadow copies.</summary>
    static readonly HashSet<string> NeverPrograms = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "cmd.exe", "mshta.exe", "wscript.exe", "cscript.exe", "rundll32.exe", "regsvr32.exe", "regsvcs.exe", "regasm.exe", "installutil.exe",
        "msbuild.exe", "bcdedit.exe", "bcdboot.exe", "vssadmin.exe", "wbadmin.exe", "diskpart.exe", "format.com", "cipher.exe", "net.exe", "net1.exe",
        "wmic.exe", "certutil.exe", "bitsadmin.exe", "takeown.exe", "mountvol.exe", "fsutil.exe", "cmdkey.exe", "vaultcmd.exe", "reagentc.exe",
        "manage-bde.exe", "ntdsutil.exe", "esentutl.exe", "procdump.exe", "procdump64.exe", "psexec.exe", "psexec64.exe", "wsl.exe", "bash.exe",
        "forfiles.exe", "pcalua.exe", "schtasks.exe", "at.exe", "control.exe", "mmc.exe", "explorer.exe", "taskmgr.exe", "secedit.exe", "auditpol.exe",
        "lsass.exe", "dism.exe", "pnputil.exe", "sdbinst.exe", "tscon.exe", "runas.exe", "nexus-elevate.exe", "nexus-launch.exe"
    };

    /// <summary>Words that no argument of a privileged operation may contain.</summary>
    static readonly string[] NeverWords = {
        "disablerealtimemonitoring", "disableantispyware", "disableioavprotection", "disablebehaviormonitoring", "windefend", "wdfilter", "mpssvc",
        "set-mppreference", "add-mppreference", "remove-mppreference", "tamperprotection", "enablelua", "consentpromptbehavior", "promptonsecuredesktop",
        "filteradministratortoken", "localaccounttokenfilterpolicy", "bitdefender", "bdservicehost", "vsserv", "bdredline", "testsigning",
        "nointegritychecks", "bootstatuspolicy", "recoveryenabled", "safeboot", "\\sam", "\\security\\", "\\system32\\config", "lsass", "sekurlsa",
        "mimikatz", "localgroup", "new-localuser", "set-localuser", "add-localgroupmember", "remove-localgroupmember", "net user", "-encodedcommand",
        "invoke-expression", "downloadstring", "downloadfile", "frombase64string", "invoke-webrequest", "start-bitstransfer", "credentialmanager",
        "\\microsoft\\credentials", "\\microsoft\\protect", "dpapi", "opmode disable", "state off", "nexusprivilege", "nexus\\overnight.key",
        "secrets.bin", ".protected", "set-executionpolicy", "uninstall-windowsfeature", "disable-windowsoptionalfeature -featurename windows-defender"
    };

    public static string FinalPath(string path, bool directory)
    {
        IntPtr h = N.CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, directory ? 0x02000000u : 0u, IntPtr.Zero);   // FILE_READ_ATTRIBUTES; backup semantics for folders
        if (h == new IntPtr(-1)) throw new Refused("not found: " + path);
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint n = N.GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
            if (n == 0 || n >= sb.Capacity) throw new Refused("the path could not be resolved");
            string s = sb.ToString();
            if (s.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal)) throw new Refused("a network path is not run");
            if (s.StartsWith("\\\\?\\", StringComparison.Ordinal)) s = s.Substring(4);
            return s;
        }
        finally { N.CloseHandle(h); }
    }

    static string Canonical(string given, bool directory, string what)
    {
        if (given.Length < 4 || given.Length > 260 || !char.IsLetter(given[0]) || given[1] != ':' || given[2] != '\\') throw new Refused(what + " must be an absolute path");
        if (given.IndexOf(':', 2) >= 0 || given.IndexOf('~') >= 0 || given.IndexOf('/') >= 0 || given.Contains("\\\\") || given.Contains("\\.\\") || given.Contains("\\..\\") || given.EndsWith("\\..") || given.EndsWith(" ") || given.EndsWith("."))
            throw new Refused(what + " is not in canonical form");
        string final = FinalPath(given, directory);
        if (!string.Equals(final, given, StringComparison.OrdinalIgnoreCase)) throw new Refused(what + " is not its own final path (a link, a junction or a short name): " + final);
        return final;
    }

    public static bool Under(string path, string root) { return root != null && path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }

    public static bool ProtectedProgram(string path)
    {
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        return Under(path, Path.Combine(win, "System32")) || Under(path, Path.Combine(win, "SysWOW64"))
            || Under(path, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)) || Under(path, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
    }

    static string Sha256Of(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            return BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
    }

    /// <summary>Copies a file into the operation's staging folder and checks it there: what runs is what was reviewed.</summary>
    static string Stage(string source, string sha256, string opDir, List<FileStream> holds)
    {
        if (sha256 == null || !new Regex("^[0-9a-f]{64}$").IsMatch(sha256)) throw new Refused("a program or file outside the protected program folders needs its SHA-256");
        Directory.CreateDirectory(opDir);
        string target = Path.Combine(opDir, Path.GetFileName(source));
        if (File.Exists(target)) throw new Refused("two staged files have the same name: " + Path.GetFileName(source));
        File.Copy(source, target, false);
        // The copy is opened for reading with a share mode that lets nobody write or delete it, and the hash is taken from
        // that very handle: the bytes that were hashed are the bytes that run. The handle stays open until the program ended.
        FileStream hold = null;
        try
        {
            hold = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read);
            string actual;
            using (SHA256 sha = SHA256.Create()) actual = BitConverter.ToString(sha.ComputeHash(hold)).Replace("-", "").ToLowerInvariant();
            if (actual != sha256) throw new Refused("the SHA-256 of " + Path.GetFileName(source) + " is not the one that was reviewed");
            hold.Position = 0;
        }
        catch (Exception)
        {
            if (hold != null) hold.Dispose();
            try { File.Delete(target); } catch (Exception) { }
            throw;
        }
        holds.Add(hold);
        return target;
    }

    static string Exec(Dictionary<string, object> body)
    {
        string opId = Json.Str(body, "opId", true);
        if (!new Regex("^[A-Za-z0-9-]{1,80}$").IsMatch(opId)) throw new Refused("opId is not valid");
        string capability = Json.Str(body, "capability", true);
        if (!capabilities.Contains(capability)) throw new Refused("the capability " + capability + " is not part of this session");
        string executable = Canonical(Json.Str(body, "executable", true), false, "the executable");
        string name = Path.GetFileName(executable);
        if (NeverPrograms.Contains(name)) throw new Refused(name + " is never run by a privilege session");
        object a;
        List<string> args = new List<string>();
        if (body.TryGetValue("args", out a) && a != null)
        {
            List<object> list = a as List<object>;
            if (list == null || list.Count > 64) throw new Refused("args must be a list of at most 64 strings");
            foreach (object x in list)
            {
                string s = x as string;
                if (s == null || s.Length > 4096 || s.IndexOf('\0') >= 0) throw new Refused("each argument is a string of at most 4096 characters");
                args.Add(s);
            }
        }
        string joined = (executable + " " + string.Join(" ", args.ToArray())).ToLowerInvariant();
        foreach (string word in NeverWords) if (joined.Contains(word)) throw new Refused("an argument names something no privilege session touches (" + word + ")");

        // The capability's template, checked here as well as in the runtime: a request that never passed the runtime's
        // policy cannot do more than the templates allow.
        HashSet<int> declared = new HashSet<int>();
        object declaredInputs;
        if (body.TryGetValue("inputs", out declaredInputs) && declaredInputs != null)
        {
            List<object> list = declaredInputs as List<object>;
            if (list != null)
                foreach (object x in list)
                {
                    Dictionary<string, object> entry = x as Dictionary<string, object>;
                    object idx;
                    if (entry != null && entry.TryGetValue("arg", out idx) && idx is double) declared.Add((int)(double)idx);
                }
        }
        Watch watch = Templates.Check(capability, executable, args, declared, staging);

        // Files an argument names whose content was reviewed (a script, a package): copied into the staging folder,
        // checked there, and the argument then names the copy.
        string opDir = Path.Combine(staging, opId);
        if (Directory.Exists(opDir)) throw new Refused("this operation id was used already");
        List<FileStream> holds = new List<FileStream>();
        try
        {
            return ExecStaged(body, opId, executable, name, args, opDir, holds, watch);
        }
        finally { foreach (FileStream h in holds) { try { h.Dispose(); } catch (Exception) { } } }
    }

    static string ExecStaged(Dictionary<string, object> body, string opId, string executable, string name, List<string> args, string opDir, List<FileStream> holds, Watch watch)
    {
        HashSet<int> staged = new HashSet<int>();
        object ins;
        if (body.TryGetValue("inputs", out ins) && ins != null)
        {
            List<object> list = ins as List<object>;
            if (list == null || list.Count > 8) throw new Refused("inputs is a list of at most 8 entries");
            foreach (object x in list)
            {
                Dictionary<string, object> entry = x as Dictionary<string, object>;
                object idx;
                if (entry == null || !entry.TryGetValue("arg", out idx) || !(idx is double)) throw new Refused("each input names the index of its argument");
                int i = (int)(double)idx;
                if (i < 0 || i >= args.Count || staged.Contains(i)) throw new Refused("an input names no argument");
                args[i] = Stage(Canonical(args[i], false, "an input"), Json.Str(entry, "sha256", true), opDir, holds);
                staged.Add(i);
            }
        }
        bool shell = name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase);
        string stagedSha = null;
        if (shell)
        {
            // A script file whose content was reviewed, and nothing else: no -Command, no encoded command.
            string[] head = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File" };
            if (args.Count < 6) throw new Refused("PowerShell is run only as -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <reviewed script>");
            for (int i = 0; i < head.Length; i++) if (!string.Equals(args[i], head[i], StringComparison.OrdinalIgnoreCase)) throw new Refused("PowerShell is run only as -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <reviewed script>");
            for (int i = head.Length + 1; i < args.Count; i++) if (args[i].StartsWith("-Command", StringComparison.OrdinalIgnoreCase) || args[i].StartsWith("-Enc", StringComparison.OrdinalIgnoreCase)) throw new Refused("no command string after the script");
            if (!ProtectedProgram(executable)) throw new Refused("PowerShell must be the system's own");
            if (!staged.Contains(5) || !args[5].EndsWith(".ps1", StringComparison.OrdinalIgnoreCase)) throw new Refused("the script must be a reviewed .ps1 file (an input)");
        }
        if (!ProtectedProgram(executable))
        {
            stagedSha = Json.Str(body, "sha256", true);
            executable = Stage(executable, stagedSha, opDir, holds);
        }
        // Files the staged ones need beside them (a script's companion), checked the same way; no argument names them.
        object fs;
        if (body.TryGetValue("files", out fs) && fs != null)
        {
            List<object> list = fs as List<object>;
            if (list == null || list.Count > 8) throw new Refused("files is a list of at most 8 entries");
            foreach (object x in list)
            {
                Dictionary<string, object> entry = x as Dictionary<string, object>;
                if (entry == null) throw new Refused("each file is an object");
                Stage(Canonical(Json.Str(entry, "path", true), false, "a file"), Json.Str(entry, "sha256", true), opDir, holds);
            }
        }

        string cwd = Json.Str(body, "cwd", false);
        cwd = cwd == null ? staging : Canonical(cwd, true, "the working directory");
        int timeout = 300000;
        object t;
        if (body.TryGetValue("timeoutMs", out t) && t != null)
        {
            if (!(t is double) || (double)t < 1000 || (double)t > 1800000) throw new Refused("timeoutMs is between 1000 and 1800000");
            timeout = (int)(double)t;
        }
        IntPtr env = BuildEnvironment(body);
        try { return Run(opId, executable, args, cwd, env, timeout, stagedSha, watch); }
        finally { Marshal.FreeHGlobal(env); }
    }

    static readonly HashSet<string> ReservedVariables = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PSMODULEPATH", "NODE_OPTIONS", "PSEXECUTIONPOLICYPREFERENCE",
        "__COMPAT_LAYER", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COR_ENABLE_PROFILING",
        "COR_PROFILER", "COR_PROFILER_PATH", "CORECLR_ENABLE_PROFILING", "CORECLR_PROFILER", "CORECLR_PROFILER_PATH", "DOTNET_STARTUP_HOOKS", "PYTHONPATH",
        "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "ELECTRON_RUN_AS_NODE", "LD_PRELOAD"
    };

    /// <summary>The environment block: a fixed set of the machine's own variables and what the request names, nothing of the broker's.</summary>
    static IntPtr BuildEnvironment(Dictionary<string, object> body)
    {
        string win = System.Environment.GetFolderPath(System.Environment.SpecialFolder.Windows);
        SortedDictionary<string, string> vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string sys = Path.Combine(win, "System32");
        vars["SystemRoot"] = win; vars["windir"] = win; vars["SystemDrive"] = win.Substring(0, 2);
        vars["ComSpec"] = Path.Combine(sys, "cmd.exe");
        vars["PATH"] = sys + ";" + win + ";" + Path.Combine(sys, "Wbem") + ";" + Path.Combine(sys, "WindowsPowerShell\\v1.0");
        vars["PATHEXT"] = ".COM;.EXE";
        vars["TEMP"] = staging; vars["TMP"] = staging;
        vars["ProgramData"] = System.Environment.GetFolderPath(System.Environment.SpecialFolder.CommonApplicationData);
        vars["ProgramFiles"] = System.Environment.GetFolderPath(System.Environment.SpecialFolder.ProgramFiles);
        vars["ProgramFiles(x86)"] = System.Environment.GetFolderPath(System.Environment.SpecialFolder.ProgramFilesX86);
        vars["NUMBER_OF_PROCESSORS"] = System.Environment.ProcessorCount.ToString(CultureInfo.InvariantCulture);
        vars["PROCESSOR_ARCHITECTURE"] = "AMD64";
        object e;
        if (body.TryGetValue("env", out e) && e != null)
        {
            Dictionary<string, object> given = e as Dictionary<string, object>;
            if (given == null || given.Count > 32) throw new Refused("env must be an object of at most 32 variables");
            foreach (KeyValuePair<string, object> kv in given)
            {
                string v = kv.Value as string;
                if (!new Regex("^[A-Za-z_][A-Za-z0-9_]{0,63}$").IsMatch(kv.Key) || ReservedVariables.Contains(kv.Key)) throw new Refused("the variable " + kv.Key + " may not be set");
                if (v == null || v.Length > 4096 || v.IndexOf('\0') >= 0) throw new Refused("the value of " + kv.Key + " is not valid");
                vars[kv.Key] = v;
            }
        }
        StringBuilder sb = new StringBuilder();
        foreach (KeyValuePair<string, string> kv in vars) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static IntPtr privateDesktop = IntPtr.Zero;

    static string Desktop()
    {
        if (privateDesktop == IntPtr.Zero)
        {
            // A desktop of the broker's own: whatever window a privileged program opens is on no screen.
            privateDesktop = N.CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
            if (privateDesktop == IntPtr.Zero) throw new Refused("the broker's desktop could not be made: " + Marshal.GetLastWin32Error());
        }
        return "WinSta0\\" + desktop;
    }

    sealed class Capture
    {
        public readonly MemoryStream Data = new MemoryStream();
        public bool Truncated;
        public Thread Thread;
        public void Start(IntPtr read)
        {
            FileStream f = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false);
            Thread = new Thread(delegate ()
            {
                byte[] b = new byte[4096];
                int n;
                try
                {
                    while ((n = f.Read(b, 0, b.Length)) > 0)
                    {
                        int room = 65536 - (int)Data.Length;
                        if (room > 0) Data.Write(b, 0, Math.Min(room, n));
                        if (n > room) Truncated = true;
                    }
                }
                catch (IOException) { }
                f.Dispose();
            });
            Thread.IsBackground = true;
            Thread.Start();
        }
        public string Text() { return new UTF8Encoding(false, false).GetString(Data.ToArray()); }
    }

    static bool usedInstaller;
    static readonly List<string> touchedServices = new List<string>();

    /// <summary>Is a Windows Installer installation (the service's, outside the job) still running? Waits up to waitMs for the installer mutex to be free; null when it is.</summary>
    static string InstallerBusy(uint waitMs)
    {
        IntPtr m = N.OpenMutexW(0x00100000 | 0x1, false, "Global\\_MSIExecute");   // SYNCHRONIZE | MUTEX_MODIFY_STATE
        if (m == IntPtr.Zero)
        {
            int e = Marshal.GetLastWin32Error();
            return e == 2 ? null : "whether a Windows Installer installation is still running could not be checked (error " + e + ")";
        }
        try
        {
            uint r = N.WaitForSingleObject(m, waitMs);
            if (r == 0 || r == 0x80) { N.ReleaseMutex(m); return null; }
            return "a Windows Installer installation may still be running: the installer mutex was still held after " + (waitMs / 1000) + " s; the broker does not stop it";
        }
        finally { N.CloseHandle(m); }
    }

    static string ServiceState(string service, string verb)
    {
        IntPtr scm = N.OpenSCManagerW(null, null, 0x1);
        if (scm == IntPtr.Zero) return "the state of the service " + service + " could not be read (error " + Marshal.GetLastWin32Error() + ")";
        try
        {
            IntPtr svc = N.OpenServiceW(scm, service, 0x4);   // SERVICE_QUERY_STATUS
            if (svc == IntPtr.Zero) return "the state of the service " + service + " could not be read (error " + Marshal.GetLastWin32Error() + ")";
            try
            {
                SERVICE_STATUS st = new SERVICE_STATUS();
                for (int i = 0; i < 20; i++)
                {
                    if (!N.QueryServiceStatus(svc, out st)) return "the state of the service " + service + " could not be read (error " + Marshal.GetLastWin32Error() + ")";
                    if (st.dwCurrentState == 1 || st.dwCurrentState == 4 || st.dwCurrentState == 7) break;
                    Thread.Sleep(500);   // a start or stop in progress settles
                }
                string[] names = { "?", "stopped", "start pending", "stop pending", "running", "continue pending", "pause pending", "paused" };
                string state = st.dwCurrentState < names.Length ? names[st.dwCurrentState] : "state " + st.dwCurrentState;
                return "the service " + service + " is " + state + (verb == "start" && st.dwCurrentState != 1 ? " (this session started it; the broker does not stop it)" : verb == "stop" && st.dwCurrentState != 1 ? " (this session asked it to stop)" : "");
            }
            finally { N.CloseServiceHandle(svc); }
        }
        finally { N.CloseServiceHandle(scm); }
    }

    /// <summary>What an operation may have left running outside its job, as text for the result (null: nothing known to be left).</summary>
    static string LeftoverOf(Watch w)
    {
        List<string> notes = new List<string>();
        try
        {
            if (w != null && w.Msi) { usedInstaller = true; string m = InstallerBusy(60000); if (m != null) notes.Add(m); }
            if (w != null && w.Service != null)
            {
                lock (touchedServices) if (!touchedServices.Contains(w.Service)) touchedServices.Add(w.Service);
                string s = ServiceState(w.Service, w.Verb);
                if (s != null) notes.Add(s);
            }
        }
        catch (Exception e) { notes.Add("what is left running could not be checked: " + e.GetType().Name); }
        return notes.Count == 0 ? null : string.Join("; ", notes.ToArray());
    }

    /// <summary>At the session's end: Windows Installer work and the services this session touched.</summary>
    static string SessionLeftover()
    {
        List<string> notes = new List<string>();
        if (usedInstaller) { string m = InstallerBusy(60000); if (m != null) notes.Add(m); }
        string[] services;
        lock (touchedServices) services = touchedServices.ToArray();
        foreach (string s in services) { string t = ServiceState(s, null); if (t != null) notes.Add(t); }
        return notes.Count == 0 ? null : string.Join("; ", notes.ToArray());
    }

    static string Run(string opId, string executable, List<string> args, string cwd, IntPtr env, int timeoutMs, string stagedSha, Watch watch)
    {
        StringBuilder cmd = new StringBuilder(Program.QuoteArg(executable));
        foreach (string a in args) cmd.Append(' ').Append(Program.QuoteArg(a));
        if (cmd.Length > 32000) throw new Refused("the command line is too long");

        IntPtr job = N.CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Refused("the job could not be made");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION ex = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ex.Basic.LimitFlags = 0x2000 | 0x400 | 0x8;   // kill on close, die on unhandled exception, active process limit
        ex.Basic.ActiveProcessLimit = 64;
        IntPtr exb = Marshal.AllocHGlobal(Marshal.SizeOf(ex)); Marshal.StructureToPtr(ex, exb, false);
        bool limited = N.SetInformationJobObject(job, 9, exb, Marshal.SizeOf(ex));
        Marshal.FreeHGlobal(exb);
        if (!limited) { N.CloseHandle(job); throw new Refused("the job limits could not be set"); }
        lock (jobs) { if (ending) { N.CloseHandle(job); throw new Refused("the session is ending"); } jobs.Add(job); }

        SECURITY_ATTRIBUTES inherit = new SECURITY_ATTRIBUTES(); inherit.nLength = Marshal.SizeOf(inherit); inherit.bInheritHandle = true;
        IntPtr outR, outW, errR, errW;
        if (!N.CreatePipe(out outR, out outW, ref inherit, 0) || !N.CreatePipe(out errR, out errW, ref inherit, 0)) throw new Refused("the output pipes could not be made");
        N.SetHandleInformation(outR, 1, 0); N.SetHandleInformation(errR, 1, 0);
        IntPtr nul = N.CreateFileW("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        N.SetHandleInformation(nul, 1, 1);

        STARTUPINFO si = new STARTUPINFO();
        si.cb = (uint)Marshal.SizeOf(si);
        si.lpDesktop = Desktop();
        si.dwFlags = 0x100 | 0x1;    // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
        si.wShowWindow = 0;          // SW_HIDE
        si.hStdInput = nul; si.hStdOutput = outW; si.hStdError = errW;
        PROCESS_INFORMATION pi;
        DateTime started = DateTime.UtcNow;
        bool ok = N.CreateProcessW(executable, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000 | 0x400, env, cwd, ref si, out pi);   // suspended, no window, unicode environment
        int startError = Marshal.GetLastWin32Error();
        N.CloseHandle(outW); N.CloseHandle(errW); N.CloseHandle(nul);
        Capture stdout = new Capture(), stderr = new Capture();
        stdout.Start(outR); stderr.Start(errR);
        if (!ok) { stdout.Thread.Join(1000); stderr.Thread.Join(1000); throw new Refused("the program could not be started: " + startError); }
        if (!N.AssignProcessToJobObject(job, pi.hProcess)) { N.TerminateProcess(pi.hProcess, 1); N.CloseHandle(pi.hThread); N.CloseHandle(pi.hProcess); throw new Refused("the program could not be put in its job"); }
        N.ResumeThread(pi.hThread);
        N.CloseHandle(pi.hThread);
        bool timedOut = N.WaitForSingleObject(pi.hProcess, (uint)timeoutMs) == 258;
        if (timedOut) N.TerminateJobObject(job, 124);
        uint code;
        N.GetExitCodeProcess(pi.hProcess, out code);
        N.CloseHandle(pi.hProcess);
        // What the program left running is given five seconds, then ended with the job.
        uint leftover = ActiveIn(job);
        for (int i = 0; i < 50 && leftover > 0; i++) { Thread.Sleep(100); leftover = ActiveIn(job); }
        if (leftover > 0) N.TerminateJobObject(job, 1);
        stdout.Thread.Join(5000); stderr.Thread.Join(5000);
        lock (jobs) jobs.Remove(job);
        N.CloseHandle(job);
        long ms = (long)(DateTime.UtcNow - started).TotalMilliseconds;
        // Installer and service work happens outside the job: say what may still be going on (never stopped here).
        string outliving = LeftoverOf(watch);
        return Json.Ev("result", "opId", opId, "exitCode", (long)(int)code, "durationMs", ms, "timedOut", timedOut, "executable", executable,
            "stagedSha256", stagedSha, "leftoverEnded", (long)leftover, "leftover", outliving,"stdout", stdout.Text(), "stdoutTruncated", stdout.Truncated, "stderr", stderr.Text(), "stderrTruncated", stderr.Truncated, "desktop", desktop);
    }

    static uint ActiveIn(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acc = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        int size = Marshal.SizeOf(acc);
        IntPtr b = Marshal.AllocHGlobal(size);
        try
        {
            int ret;
            if (!N.QueryInformationJobObject(job, 1, b, size, out ret)) return 0;
            acc = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(b, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return acc.ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(b); }
    }
}
