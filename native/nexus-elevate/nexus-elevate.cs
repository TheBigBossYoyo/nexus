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
// 7 not elevated, 8 a client other than the relay connected, 9 the session could not be verified.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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
            if (N.WaitForSingleObject(broker, 0) == 0) { Say("failed", "reason", "the broker ended before it could be reached"); return EXIT_UNREACHABLE; }
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

        // The relay: the process given, still the one that was started then, and this very program.
        IntPtr client = N.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED, false, clientPid);
        if (client == IntPtr.Zero || Program.Creation(client) != clientCreated || !SameFile(Program.ImageOf(client), Program.ImageOf(N.GetCurrentProcess()))) return 9;
        IntPtr runtime = N.OpenProcess(SYNCHRONIZE, false, runtimePid);
        if (runtime == IntPtr.Zero) return 9;

        staging = test ? Path.GetFullPath(Program.Need(o, "staging", null)) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NexusPrivilege", session);
        PrepareStaging(test);
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

    static void PrepareStaging(bool test)
    {
        Directory.CreateDirectory(staging);
        if (test) return;
        // Only SYSTEM and administrators may write here: what is run from here is what was checked here.
        System.Security.AccessControl.DirectorySecurity ds = new System.Security.AccessControl.DirectorySecurity();
        ds.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        Directory.SetAccessControl(staging, ds);
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
        try { Reply(Json.Ev("ended", "reason", why)); } catch (Exception) { }
        try { pipe.Dispose(); } catch (Exception) { }
        // Nothing of the session stays: the staged copies go with it.
        for (int i = 0; i < 10 && staging != null && Directory.Exists(staging); i++)
        {
            try { Directory.Delete(staging, true); } catch (Exception) { Thread.Sleep(200); }
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

    static string FinalPath(string path, bool directory)
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

    static bool Under(string path, string root) { return root != null && path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }

    static bool ProtectedProgram(string path)
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
    static string Stage(string source, string sha256, string opDir)
    {
        if (sha256 == null || !new Regex("^[0-9a-f]{64}$").IsMatch(sha256)) throw new Refused("a program or file outside the protected program folders needs its SHA-256");
        Directory.CreateDirectory(opDir);
        string target = Path.Combine(opDir, Path.GetFileName(source));
        if (File.Exists(target)) throw new Refused("two staged files have the same name: " + Path.GetFileName(source));
        File.Copy(source, target, false);
        string actual = Sha256Of(target);
        if (actual != sha256) { try { File.Delete(target); } catch (Exception) { } throw new Refused("the SHA-256 of " + Path.GetFileName(source) + " is not the one that was reviewed"); }
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

        // Files an argument names whose content was reviewed (a script, a package): copied into the staging folder,
        // checked there, and the argument then names the copy.
        string opDir = Path.Combine(staging, opId);
        if (Directory.Exists(opDir)) throw new Refused("this operation id was used already");
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
                args[i] = Stage(Canonical(args[i], false, "an input"), Json.Str(entry, "sha256", true), opDir);
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
            executable = Stage(executable, stagedSha, opDir);
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
                Stage(Canonical(Json.Str(entry, "path", true), false, "a file"), Json.Str(entry, "sha256", true), opDir);
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
        try { return Run(opId, executable, args, cwd, env, timeout, stagedSha); }
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

    static string Run(string opId, string executable, List<string> args, string cwd, IntPtr env, int timeoutMs, string stagedSha)
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
        return Json.Ev("result", "opId", opId, "exitCode", (long)(int)code, "durationMs", ms, "timedOut", timedOut, "executable", executable,
            "stagedSha256", stagedSha, "leftoverEnded", (long)leftover, "stdout", stdout.Text(), "stdoutTruncated", stdout.Truncated, "stderr", stderr.Text(), "stderrTruncated", stderr.Truncated, "desktop", desktop);
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
