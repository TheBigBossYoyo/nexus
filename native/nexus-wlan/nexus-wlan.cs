// nexus-wlan: reads the state of the machine's Wi-Fi and asks Windows to connect a profile it has ALREADY saved.
//
// It uses the official Native Wifi API (wlanapi.dll). Subcommands, each printing JSON on stdout:
//
//   status                              one object: the Wi-Fi interfaces and what each is connected to
//   profiles                            one object: the saved profiles of each interface (name, open or secured, auto-connect)
//   connect <interfaceGuid> <profile>   asks Windows to connect the saved profile NAME (profile mode), waits for its answer
//   watch                               one JSON line per connection notification, until stdin is closed
//
// What this program never does, by construction (the calls are not declared below, and a test reads this file
// for them): it adds, changes, renames, deletes or exports no profile (no function that writes a profile list or
// a profile is declared); it never asks for a key (WlanGetProfile
// is called with flags 0, never WLAN_PROFILE_GET_PLAINTEXT_KEY, and only to read whether the profile is open);
// it never prints a profile's XML; it connects only a name that is in the saved list, and never an open network;
// it connects in profile mode only (no SSID, no scan-and-join). It takes no input but its arguments.
//
// Build (C# 5, the compiler that ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /platform:x64 /target:exe
//       /out:nexus-wlan.exe nexus-wlan.cs
//
// Exit codes: 0 done, 1 failed (the JSON says why, ok:false), 2 wrong arguments.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Native
{
    [DllImport("kernel32.dll")]
    public static extern uint SetErrorMode(uint mode);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanOpenHandle(uint clientVersion, IntPtr reserved, out uint negotiatedVersion, out IntPtr clientHandle);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanCloseHandle(IntPtr clientHandle, IntPtr reserved);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanEnumInterfaces(IntPtr clientHandle, IntPtr reserved, out IntPtr interfaceList);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanQueryInterface(IntPtr clientHandle, ref Guid interfaceGuid, int opCode, IntPtr reserved, out uint dataSize, out IntPtr data, IntPtr opcodeValueType);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanGetProfileList(IntPtr clientHandle, ref Guid interfaceGuid, IntPtr reserved, out IntPtr profileList);

    [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
    public static extern uint WlanGetProfile(IntPtr clientHandle, ref Guid interfaceGuid, string profileName, IntPtr reserved, out IntPtr profileXml, ref uint flags, out uint grantedAccess);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanConnect(IntPtr clientHandle, ref Guid interfaceGuid, ref WLAN_CONNECTION_PARAMETERS parameters, IntPtr reserved);

    public delegate void WlanNotificationCallback(IntPtr data, IntPtr context);

    [DllImport("wlanapi.dll")]
    public static extern uint WlanRegisterNotification(IntPtr clientHandle, uint notificationSource, bool ignoreDuplicate, WlanNotificationCallback callback, IntPtr callbackContext, IntPtr reserved, out uint previousNotificationSource);

    [DllImport("wlanapi.dll")]
    public static extern void WlanFreeMemory(IntPtr memory);

    [DllImport("iphlpapi.dll")]
    public static extern uint ConvertInterfaceGuidToLuid(ref Guid interfaceGuid, out ulong luid);

    [DllImport("iphlpapi.dll", CharSet = CharSet.Unicode)]
    public static extern uint ConvertInterfaceLuidToAlias(ref ulong luid, StringBuilder alias, UIntPtr length);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct WLAN_CONNECTION_PARAMETERS
{
    public int wlanConnectionMode;      // 0 = wlan_connection_mode_profile
    public string strProfile;           // the profile NAME
    public IntPtr pDot11Ssid;           // null in profile mode
    public IntPtr pDesiredBssidList;    // null
    public int dot11BssType;            // 1 = dot11_BSS_type_infrastructure
    public uint dwFlags;                // 0
}

static class Program
{
    const uint ACM = 0x00000008;        // WLAN_NOTIFICATION_SOURCE_ACM
    const int OP_CURRENT_CONNECTION = 7; // wlan_intf_opcode_current_connection
    const int N_CONNECTION_COMPLETE = 10;
    const int N_CONNECTION_ATTEMPT_FAIL = 11;
    const int N_DISCONNECTED = 20;

    static Native.WlanNotificationCallback keepAlive;   // the callback must outlive the call that registered it
    static readonly object OutLock = new object();

    static int Main(string[] args)
    {
        // First, before anything else: no Windows error dialog may appear in an unattended run.
        Native.SetErrorMode(0x8003);
        try
        {
            if (args.Length == 1 && args[0] == "status") return Run(Status);
            if (args.Length == 1 && args[0] == "profiles") return Run(Profiles);
            if (args.Length == 3 && args[0] == "connect") return Run(delegate (IntPtr h) { return Connect(h, args[1], args[2]); });
            if (args.Length == 1 && args[0] == "watch") return Watch();
        }
        catch (Exception e)
        {
            Print("{\"ok\":false,\"error\":" + Str("unexpected: " + e.GetType().Name) + "}");
            return 1;
        }
        Console.Error.WriteLine("usage: nexus-wlan status | profiles | connect <interfaceGuid> <profileName> | watch");
        return 2;
    }

    delegate string Command(IntPtr handle);

    static int Run(Command command)
    {
        IntPtr handle;
        uint version;
        uint r = Native.WlanOpenHandle(2, IntPtr.Zero, out version, out handle);
        if (r != 0)
        {
            Print("{\"ok\":false,\"error\":" + Str("WlanOpenHandle failed (" + r + ")") + ",\"win32\":" + r + "}");
            return 1;
        }
        try
        {
            string json = command(handle);
            Print(json);
            return json.StartsWith("{\"ok\":true") ? 0 : 1;
        }
        finally
        {
            Native.WlanCloseHandle(handle, IntPtr.Zero);
        }
    }

    // ---- JSON helpers: strings are escaped, non-ASCII is written as \uXXXX, so the output is plain ASCII ------------

    static string Str(string s)
    {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static void Print(string line)
    {
        lock (OutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    // ---- reading native structures --------------------------------------------------------------------------------

    class Iface
    {
        public Guid Guid;
        public string Description;
        public int State;
    }

    static List<Iface> Interfaces(IntPtr handle)
    {
        List<Iface> list = new List<Iface>();
        IntPtr p;
        if (Native.WlanEnumInterfaces(handle, IntPtr.Zero, out p) != 0) return list;
        try
        {
            int count = Marshal.ReadInt32(p, 0);
            // WLAN_INTERFACE_INFO: GUID (16), WCHAR[256] description (512), state (4) = 532 bytes; the array starts at offset 8.
            for (int i = 0; i < count && i < 16; i++)
            {
                IntPtr item = new IntPtr(p.ToInt64() + 8 + i * 532);
                byte[] g = new byte[16];
                Marshal.Copy(item, g, 0, 16);
                Iface f = new Iface();
                f.Guid = new Guid(g);
                f.Description = Marshal.PtrToStringUni(new IntPtr(item.ToInt64() + 16), 256).Split('\0')[0];
                f.State = Marshal.ReadInt32(item, 528);
                list.Add(f);
            }
        }
        finally { Native.WlanFreeMemory(p); }
        return list;
    }

    static string StateName(int s)
    {
        switch (s)
        {
            case 0: return "not_ready";
            case 1: return "connected";
            case 2: return "ad_hoc_network_formed";
            case 3: return "disconnecting";
            case 4: return "disconnected";
            case 5: return "associating";
            case 6: return "discovering";
            case 7: return "authenticating";
            default: return "unknown";
        }
    }

    static string Alias(Guid guid)
    {
        ulong luid;
        if (Native.ConvertInterfaceGuidToLuid(ref guid, out luid) != 0) return null;
        StringBuilder b = new StringBuilder(257);
        if (Native.ConvertInterfaceLuidToAlias(ref luid, b, new UIntPtr(257)) != 0) return null;
        return b.ToString();
    }

    static string Status(IntPtr handle)
    {
        StringBuilder b = new StringBuilder("{\"ok\":true,\"interfaces\":[");
        bool first = true;
        foreach (Iface f in Interfaces(handle))
        {
            string profile = null, ssid = null;
            int signal = -1;
            Guid guid = f.Guid;
            IntPtr data;
            uint size;
            if (f.State == 1 && Native.WlanQueryInterface(handle, ref guid, OP_CURRENT_CONNECTION, IntPtr.Zero, out size, out data, IntPtr.Zero) == 0)
            {
                try
                {
                    // WLAN_CONNECTION_ATTRIBUTES: state (4), mode (4), WCHAR[256] profile name (512) at 8, then the association
                    // attributes at 520: DOT11_SSID { length (4), bytes (32) }, BSS type (4), BSSID (6), PHY type (4) at 568,
                    // PHY index (4), signal quality 0..100 (4) at 576.
                    profile = Marshal.PtrToStringUni(new IntPtr(data.ToInt64() + 8), 256).Split('\0')[0];
                    int len = Marshal.ReadInt32(data, 520);
                    if (len > 0 && len <= 32)
                    {
                        byte[] raw = new byte[len];
                        Marshal.Copy(new IntPtr(data.ToInt64() + 524), raw, 0, len);
                        ssid = Encoding.UTF8.GetString(raw);
                    }
                    signal = Marshal.ReadInt32(data, 576);
                }
                finally { Native.WlanFreeMemory(data); }
            }
            if (!first) b.Append(',');
            first = false;
            b.Append("{\"guid\":").Append(Str(guid.ToString("D")))
             .Append(",\"description\":").Append(Str(f.Description))
             .Append(",\"alias\":").Append(Str(Alias(guid)))
             .Append(",\"state\":").Append(Str(StateName(f.State)))
             .Append(",\"profile\":").Append(Str(profile))
             .Append(",\"ssid\":").Append(Str(ssid))
             .Append(",\"signal\":").Append(signal >= 0 && signal <= 100 ? signal.ToString() : "null")
             .Append('}');
        }
        return b.Append("]}").ToString();
    }

    class Saved
    {
        public string Name;
        public string Security;     // open | secured | unknown
        public bool Auto;
    }

    static List<string> ProfileNames(IntPtr handle, Guid guid)
    {
        List<string> names = new List<string>();
        IntPtr p;
        if (Native.WlanGetProfileList(handle, ref guid, IntPtr.Zero, out p) != 0) return names;
        try
        {
            int count = Marshal.ReadInt32(p, 0);
            // WLAN_PROFILE_INFO: WCHAR[256] name (512), flags (4) = 516 bytes; the array starts at offset 8.
            for (int i = 0; i < count && i < 512; i++)
                names.Add(Marshal.PtrToStringUni(new IntPtr(p.ToInt64() + 8 + i * 516), 256).Split('\0')[0]);
        }
        finally { Native.WlanFreeMemory(p); }
        return names;
    }

    // Reads ONLY whether a saved profile is open and whether it connects automatically. Flags stay 0: the key is
    // never requested, and the XML is dropped at once, after two small values were taken from it.
    static Saved Inspect(IntPtr handle, Guid guid, string name)
    {
        Saved s = new Saved();
        s.Name = name;
        s.Security = "unknown";
        IntPtr xml;
        uint flags = 0, access;
        if (Native.WlanGetProfile(handle, ref guid, name, IntPtr.Zero, out xml, ref flags, out access) != 0) return s;
        try
        {
            string text = Marshal.PtrToStringUni(xml);
            Match auth = Regex.Match(text, "<authentication>\\s*([^<\\s]+)\\s*</authentication>", RegexOptions.IgnoreCase);
            Match enc = Regex.Match(text, "<encryption>\\s*([^<\\s]+)\\s*</encryption>", RegexOptions.IgnoreCase);
            Match mode = Regex.Match(text, "<connectionMode>\\s*([^<\\s]+)\\s*</connectionMode>", RegexOptions.IgnoreCase);
            if (auth.Success && enc.Success)
            {
                string a = auth.Groups[1].Value.ToLowerInvariant(), e = enc.Groups[1].Value.ToLowerInvariant();
                // Open authentication without encryption, and Enhanced Open (OWE, encrypted but unauthenticated), are open.
                s.Security = (a == "open" && e == "none") || a == "owe" ? "open" : "secured";
            }
            s.Auto = mode.Success && mode.Groups[1].Value.ToLowerInvariant() == "auto";
            text = null;
        }
        finally { Native.WlanFreeMemory(xml); }
        return s;
    }

    static string Profiles(IntPtr handle)
    {
        StringBuilder b = new StringBuilder("{\"ok\":true,\"interfaces\":[");
        bool firstIface = true;
        foreach (Iface f in Interfaces(handle))
        {
            if (!firstIface) b.Append(',');
            firstIface = false;
            b.Append("{\"guid\":").Append(Str(f.Guid.ToString("D"))).Append(",\"profiles\":[");
            bool first = true;
            foreach (string name in ProfileNames(handle, f.Guid))
            {
                Saved s = Inspect(handle, f.Guid, name);
                if (!first) b.Append(',');
                first = false;
                b.Append("{\"name\":").Append(Str(s.Name)).Append(",\"security\":").Append(Str(s.Security)).Append(",\"autoConnect\":").Append(s.Auto ? "true" : "false").Append('}');
            }
            b.Append("]}");
        }
        return b.Append("]}").ToString();
    }

    // ---- connect ---------------------------------------------------------------------------------------------------

    static string Connect(IntPtr handle, string guidText, string name)
    {
        Guid guid;
        if (!Guid.TryParse(guidText, out guid)) return "{\"ok\":false,\"error\":\"not an interface GUID\"}";
        bool known = false;
        foreach (Iface f in Interfaces(handle)) if (f.Guid == guid) known = true;
        if (!known) return "{\"ok\":false,\"error\":\"not a Wi-Fi interface of this machine\"}";
        // The name must be one of the saved profiles of this interface, character for character.
        bool saved = false;
        foreach (string n in ProfileNames(handle, guid)) if (string.Equals(n, name, StringComparison.Ordinal)) saved = true;
        if (!saved) return "{\"ok\":false,\"error\":\"that profile is not in the saved profiles\"}";
        Saved info = Inspect(handle, guid, name);
        if (info.Security != "secured") return "{\"ok\":false,\"error\":\"that profile is not a secured profile; it is not connected\"}";

        // Listen for the answer before asking, so that it cannot be missed.
        ManualResetEvent answered = new ManualResetEvent(false);
        long reason = -1;
        string outcome = "no answer within 10 seconds";
        uint prev;
        keepAlive = delegate (IntPtr data, IntPtr ctx)
        {
            int source = Marshal.ReadInt32(data, 0), code = Marshal.ReadInt32(data, 4);
            if (source != (int)ACM || (code != N_CONNECTION_COMPLETE && code != N_CONNECTION_ATTEMPT_FAIL)) return;
            byte[] g = new byte[16];
            Marshal.Copy(new IntPtr(data.ToInt64() + 8), g, 0, 16);
            if (new Guid(g) != guid) return;
            IntPtr body = Marshal.ReadIntPtr(data, 32);
            if (body == IntPtr.Zero) return;
            reason = (uint)Marshal.ReadInt32(body, 560);
            outcome = code == N_CONNECTION_COMPLETE && reason == 0 ? "connected" : "attempt failed";
            answered.Set();
        };
        Native.WlanRegisterNotification(handle, ACM, true, keepAlive, IntPtr.Zero, IntPtr.Zero, out prev);

        WLAN_CONNECTION_PARAMETERS p = new WLAN_CONNECTION_PARAMETERS();
        p.wlanConnectionMode = 0;
        p.strProfile = name;
        p.pDot11Ssid = IntPtr.Zero;
        p.pDesiredBssidList = IntPtr.Zero;
        p.dot11BssType = 1;
        p.dwFlags = 0;
        uint r = Native.WlanConnect(handle, ref guid, ref p, IntPtr.Zero);
        if (r != 0)
            return "{\"ok\":true,\"requested\":false,\"reasonCode\":null,\"win32\":" + r + ",\"detail\":" + Str("WlanConnect returned " + r) + "}";
        answered.WaitOne(10000);
        Native.WlanRegisterNotification(handle, 0, true, null, IntPtr.Zero, IntPtr.Zero, out prev);
        return "{\"ok\":true,\"requested\":true,\"reasonCode\":" + (reason >= 0 ? reason.ToString() : "null") + ",\"detail\":" + Str(outcome) + "}";
    }

    // ---- watch -----------------------------------------------------------------------------------------------------

    static int Watch()
    {
        IntPtr handle;
        uint version, prev;
        uint r = Native.WlanOpenHandle(2, IntPtr.Zero, out version, out handle);
        if (r != 0)
        {
            Print("{\"ok\":false,\"error\":" + Str("WlanOpenHandle failed (" + r + ")") + "}");
            return 1;
        }
        keepAlive = delegate (IntPtr data, IntPtr ctx)
        {
            try
            {
                int source = Marshal.ReadInt32(data, 0), code = Marshal.ReadInt32(data, 4);
                if (source != (int)ACM) return;
                string ev = null;
                if (code == N_CONNECTION_COMPLETE) ev = "connected";
                else if (code == N_CONNECTION_ATTEMPT_FAIL) ev = "attempt_failed";
                else if (code == N_DISCONNECTED) ev = "disconnected";
                if (ev == null) return;
                byte[] g = new byte[16];
                Marshal.Copy(new IntPtr(data.ToInt64() + 8), g, 0, 16);
                IntPtr body = Marshal.ReadIntPtr(data, 32);
                string profile = null;
                long reason = -1;
                if (body != IntPtr.Zero)
                {
                    profile = Marshal.PtrToStringUni(new IntPtr(body.ToInt64() + 4), 256).Split('\0')[0];
                    reason = (uint)Marshal.ReadInt32(body, 560);
                }
                // A connection that completed with a reason other than success did not connect.
                if (ev == "connected" && reason > 0) ev = "attempt_failed";
                Print("{\"event\":" + Str(ev) + ",\"guid\":" + Str(new Guid(g).ToString("D")) + ",\"profile\":" + Str(profile) + ",\"reasonCode\":" + (reason >= 0 ? reason.ToString() : "null") + "}");
            }
            catch (Exception) { }
        };
        Native.WlanRegisterNotification(handle, ACM, false, keepAlive, IntPtr.Zero, IntPtr.Zero, out prev);
        Print("{\"event\":\"watching\"}");
        // The parent closes stdin to end this program.
        while (Console.In.Read() != -1) { }
        Native.WlanRegisterNotification(handle, 0, true, null, IntPtr.Zero, IntPtr.Zero, out prev);
        Native.WlanCloseHandle(handle, IntPtr.Zero);
        return 0;
    }
}
