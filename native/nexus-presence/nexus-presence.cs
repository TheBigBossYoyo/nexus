// nexus-presence: what NEXUS's work does to the owner's screen, measured (0.9.1, zero-disturbance testing).
//
// It watches the desktop the owner uses (the input desktop of WinSta0) and reports, one JSON line per event on its
// standard output, every change of the foreground window and every top-level window that is shown there. For each
// it says which process owns the window and whether that process descends from one of the root processes it was
// given (the NEXUS runtime): a window of NEXUS's work on the owner's screen, a console that flashed, a dialog, a
// window that took the focus. It reads window classes and process names, never a window's title or contents, and
// changes nothing: it is a meter, not a guard (no SetForegroundWindow, no minimizing).
//
//   nexus-presence.exe watch --roots <pid>[,<pid>...]     until its standard input closes
//   nexus-presence.exe foreground                         one line: the foreground window now
//   nexus-presence.exe --version
//
// Lines: {"e":"ready"} {"e":"foreground"|"shown","pid":n,"process":"x.exe","class":"..","nexus":true|false,
//         "rootPid":n|null,"console":bool,"dialog":bool,"terminal":bool,"at":ms}
//
// Build (C# 5, the compiler that ships with Windows; scripts\build-presence.mjs does it):
//   csc.exe /nologo /optimize+ /platform:x64 /target:winexe /out:nexus-presence.exe nexus-presence.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

[StructLayout(LayoutKind.Sequential)]
struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }

static class N
{
    const string U = "user32.dll", K = "kernel32.dll";
    [DllImport(K)] public static extern uint SetErrorMode(uint m);
    [DllImport(U)] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport(U)] public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport(U)] public static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport(U)] public static extern bool PostThreadMessageW(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport(K)] public static extern uint GetCurrentThreadId();
    [DllImport(U)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport(U, CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
    [DllImport(U)] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport(U)] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport(U)] public static extern IntPtr GetForegroundWindow();
    [DllImport(U)] public static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport(K, SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 entry);
    [DllImport(K, SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 entry);
    [DllImport(K)] public static extern bool CloseHandle(IntPtr h);
}

static class Program
{
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_OBJECT_SHOW = 0x8002, WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2;
    static readonly HashSet<uint> roots = new HashSet<uint>();
    static readonly object outLock = new object();
    static WinEventProc keep;   // the hook's delegate must outlive the hook
    static Dictionary<uint, KeyValuePair<uint, string>> table = new Dictionary<uint, KeyValuePair<uint, string>>();
    static DateTime tableAt = DateTime.MinValue;
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static readonly long startedUnixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;

    static int Main(string[] args)
    {
        N.SetErrorMode(0x8003);
        if (args.Length == 1 && args[0] == "--version") { Console.Out.WriteLine("nexus-presence 1"); return 0; }
        if (args.Length == 1 && args[0] == "foreground") { Report("foreground", N.GetForegroundWindow()); return 0; }
        if (args.Length == 3 && args[0] == "watch" && args[1] == "--roots")
        {
            foreach (string p in args[2].Split(','))
            {
                uint pid;
                if (!uint.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out pid)) { Console.Error.WriteLine("nexus-presence: a root is not a process id"); return 2; }
                roots.Add(pid);
            }
            return Watch();
        }
        Console.Error.WriteLine("usage: nexus-presence watch --roots <pid>[,<pid>...] | foreground | --version");
        return 2;
    }

    static int Watch()
    {
        uint thread = N.GetCurrentThreadId();
        // Ends when whoever started it closes its input (the runtime ended, or no longer wants it).
        Thread input = new Thread(delegate ()
        {
            try { Stream s = Console.OpenStandardInput(); byte[] b = new byte[256]; while (s.Read(b, 0, b.Length) > 0) { } } catch (Exception) { }
            N.PostThreadMessageW(thread, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        });
        input.IsBackground = true;
        input.Start();
        keep = OnEvent;
        IntPtr fg = N.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        IntPtr show = N.SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, keep, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (fg == IntPtr.Zero || show == IntPtr.Zero) { Console.Error.WriteLine("nexus-presence: the hooks could not be set"); return 3; }
        Line("{\"e\":\"ready\",\"at\":" + Now() + "}");
        Report("foreground", N.GetForegroundWindow());
        MSG msg;
        while (N.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { }
        N.UnhookWinEvent(fg);
        N.UnhookWinEvent(show);
        return 0;
    }

    static long Now() { return startedUnixMs + clock.ElapsedMilliseconds; }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        try
        {
            if (hwnd == IntPtr.Zero) return;
            if (ev == EVENT_OBJECT_SHOW)
            {
                // Top-level windows only, and only those that are visible once shown.
                if (idObject != 0 || idChild != 0) return;
                if (N.GetAncestor(hwnd, 2 /* GA_ROOT */) != hwnd || !N.IsWindowVisible(hwnd)) return;
                // Tool windows, tooltips and the like are not windows a person sees appear.
                int exStyle = N.GetWindowLongW(hwnd, -20);
                if ((exStyle & 0x80 /* WS_EX_TOOLWINDOW */) != 0 || (exStyle & 0x08000000 /* WS_EX_NOACTIVATE */) != 0) return;
                Report("shown", hwnd);
            }
            else Report("foreground", hwnd);
        }
        catch (Exception) { }
    }

    static void Report(string kind, IntPtr hwnd)
    {
        uint pid;
        N.GetWindowThreadProcessId(hwnd, out pid);
        StringBuilder cls = new StringBuilder(128);
        N.GetClassNameW(hwnd, cls, cls.Capacity);
        string c = cls.ToString();
        string process;
        uint root = RootOf(pid, out process);
        bool console = c == "ConsoleWindowClass" || c == "PseudoConsoleWindow";
        bool terminal = c == "CASCADIA_HOSTING_WINDOW_CLASS";
        bool dialog = c == "#32770";
        Line("{\"e\":\"" + kind + "\",\"pid\":" + pid + ",\"process\":" + Quote(process) + ",\"class\":" + Quote(c.Length > 80 ? c.Substring(0, 80) : c)
            + ",\"nexus\":" + (root != 0 ? "true" : "false") + ",\"rootPid\":" + (root != 0 ? root.ToString(CultureInfo.InvariantCulture) : "null")
            + ",\"console\":" + (console ? "true" : "false") + ",\"dialog\":" + (dialog ? "true" : "false") + ",\"terminal\":" + (terminal ? "true" : "false") + ",\"at\":" + Now() + "}");
    }

    /// <summary>The root this process descends from (itself included), or 0. Parents are read from a snapshot of all
    /// processes, refreshed when a process is not in it; a chain is followed at most 64 steps, and a parent that
    /// started after its child (its id was reused) ends it.</summary>
    static uint RootOf(uint pid, out string process)
    {
        if (!table.ContainsKey(pid) || (DateTime.UtcNow - tableAt).TotalSeconds > 5) Refresh();
        KeyValuePair<uint, string> entry;
        process = table.TryGetValue(pid, out entry) ? entry.Value : "";
        uint at = pid;
        for (int i = 0; i < 64 && at != 0; i++)
        {
            if (roots.Contains(at)) return at;
            if (!table.TryGetValue(at, out entry)) return 0;
            if (entry.Key == at) return 0;
            at = entry.Key;
        }
        return 0;
    }

    static void Refresh()
    {
        Dictionary<uint, KeyValuePair<uint, string>> t = new Dictionary<uint, KeyValuePair<uint, string>>();
        IntPtr snap = N.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
        if (snap == new IntPtr(-1)) return;
        try
        {
            PROCESSENTRY32 e = new PROCESSENTRY32();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (N.Process32FirstW(snap, ref e))
                do { t[e.th32ProcessID] = new KeyValuePair<uint, string>(e.th32ParentProcessID, e.szExeFile); } while (N.Process32NextW(snap, ref e));
        }
        finally { N.CloseHandle(snap); }
        table = t;
        tableAt = DateTime.UtcNow;
    }

    static string Quote(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20 || ch > 0x7e) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    static void Line(string s)
    {
        lock (outLock)
        {
            try { Console.Out.WriteLine(s); Console.Out.Flush(); } catch (Exception) { }
        }
    }
}
