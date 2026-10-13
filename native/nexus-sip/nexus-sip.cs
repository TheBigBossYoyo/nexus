// nexus-sip: a headless SIP endpoint for NEXUS, driven over standard input and output.
//
// It wraps the official Linphone SDK (liblinphone 5.5.32, GNU AGPLv3 or later) and gives NEXUS one voice call at a
// time as raw sound: 16 kHz, mono, signed 16-bit little-endian PCM, in 20 ms pieces, in both directions. No sound
// device, no window, no console output but the protocol. NEXUS is the only thing that talks to it.
//
//   nexus-sip.exe --runtime <dir with the Linphone DLLs and share\> --state <dir>   the protocol below
//   nexus-sip.exe --selftest --runtime <dir> [--state <dir>] [--enc none|srtp|zrtp|dtls]   two cores call each other
//
// Everything liblinphone writes goes under --state. Credentials arrive only in the "configure" line on stdin; nothing
// else is read from the arguments or the environment, and nothing secret is ever written to stderr.
//
// Protocol: one JSON object per line, UTF-8, both ways. A line longer than 64 KB is refused with an "error" event.
//   stdin  {"c":"configure","identity":"sip:u@d","password":"..","displayName":"..","server":"sip:d;transport=tls",
//           "transport":"tls|tcp|udp","mediaEncryption":"none|srtp|zrtp|dtls","mediaEncryptionMandatory":true,
//           "stunServer":"host"|null,"ice":false,"jitterMs":0,"register":true,"sipPort":-1}
//          {"c":"call","to":"sip:.."}  {"c":"answer","call":id}  {"c":"decline","call":id}  {"c":"hangup","call":id}
//          {"c":"audio","call":id,"pcm":"<base64>"}  {"c":"clear","call":id}  {"c":"mark","call":id,"name":".."}
//          {"c":"refresh"}  {"c":"quit"}
//   stdout {"e":"ready","version":".."}  {"e":"registration","state":"none|progress|ok|cleared|failed","reason":".."}
//          {"e":"incoming","call":id,"from":"sip:..","fromDisplayName":"..","viaRegisteredAccount":true}
//          {"e":"call","call":id,"state":"outgoing|ringing|connected|streams|ended|error","reason":".."}
//          {"e":"media","call":id,"codec":"opus","clockRate":48000,"encryption":"none|srtp|zrtp|dtls","zrtpSas":"..","srtpSuite":".."}
//          {"e":"audio","call":id,"pcm":"<base64>"}  {"e":"dtmf","call":id,"digit":"5"}
//          {"e":"played","call":id,"name":".."}  {"e":"error","message":".."}
//
// An incoming call is never answered by this program: it rings until "answer" or "decline", and is declined after 45 s.
// A second call while one is in progress is declined as busy.
//
// Build (C# 5, the compiler that ships with Windows; scripts\build-sip.mjs does it):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /unsafe /platform:x64 /target:exe
//       /out:nexus-sip.exe nexus-sip.cs
//
// Exit codes: 0 done, 2 wrong arguments, 3 the runtime could not be loaded, 1 self-test failed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

delegate void CallStateCb(IntPtr core, IntPtr call, int state, IntPtr msg);
delegate void CallEncCb(IntPtr core, IntPtr call, byte on, IntPtr token);
delegate void RegCb(IntPtr core, IntPtr account, int state, IntPtr msg);
delegate void DtmfCb(IntPtr core, IntPtr call, int dtmf);
delegate void Sink(string line, bool audio);

static class N
{
    const string LL = "liblinphone.dll";
    const string MS = "mediastreamer2.dll";
    const string OR = "ortp.dll";
    const string BC = "bctoolbox.dll";
    const CallingConvention C = CallingConvention.Cdecl;

    [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetDllDirectory(string dir);
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr srcProcess, IntPtr src, IntPtr dstProcess, out IntPtr dst, uint access, bool inherit, uint options);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
    [DllImport("ucrtbase.dll", CallingConvention = C)] public static extern int _dup2(int from, int to);

    // ---- strings cross the boundary as UTF-8, null-terminated
    public static byte[] U(string s)
    {
        if (s == null) return null;
        byte[] b = Encoding.UTF8.GetBytes(s);
        byte[] z = new byte[b.Length + 1];
        Buffer.BlockCopy(b, 0, z, 0, b.Length);
        return z;
    }
    public static string S(IntPtr p)
    {
        if (p == IntPtr.Zero) return null;
        int n = 0;
        while (Marshal.ReadByte(p, n) != 0 && n < 65536) n++;
        byte[] b = new byte[n];
        Marshal.Copy(p, b, 0, n);
        return Encoding.UTF8.GetString(b);
    }

    [DllImport(BC, CallingConvention = C)] public static extern void bctbx_free(IntPtr p);

    // ---- factory / core
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_get_version();
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_get();
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_create_core_3(IntPtr factory, byte[] config, byte[] factoryConfig, IntPtr sysctx);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_create_core_cbs(IntPtr factory);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_create_transports(IntPtr factory);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_create_address(IntPtr factory, byte[] addr);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_factory_create_auth_info(IntPtr factory, byte[] user, byte[] userid, byte[] pass, byte[] ha1, byte[] realm, byte[] domain);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_top_resources_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_data_resources_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_sound_resources_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_ring_resources_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_image_resources_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_msplugins_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_liblinphone_plugins_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_config_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_data_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_download_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_set_cache_dir(IntPtr f, byte[] p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_factory_enable_log_collection(IntPtr f, int state);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_logging_service_get();
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_logging_service_set_log_level(IntPtr svc, int level);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_transports_set_udp_port(IntPtr t, int port);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_transports_set_tcp_port(IntPtr t, int port);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_transports_set_tls_port(IntPtr t, int port);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_transports_unref(IntPtr t);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_set_transports(IntPtr core, IntPtr t);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_start(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_iterate(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_stop(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_unref(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_add_callbacks(IntPtr core, IntPtr cbs);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_cbs_set_call_state_changed(IntPtr cbs, CallStateCb cb);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_cbs_set_call_encryption_changed(IntPtr cbs, CallEncCb cb);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_cbs_set_account_registration_state_changed(IntPtr cbs, RegCb cb);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_cbs_set_dtmf_received(IntPtr cbs, DtmfCb cb);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_user_agent(IntPtr core, byte[] name, byte[] ver);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_root_ca(IntPtr core, byte[] path);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_set_media_encryption(IntPtr core, int menc);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_media_encryption_mandatory(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_echo_cancellation(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_echo_limiter(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_video_capture(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_video_display(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_native_ringing_enabled(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_get_ms_factory(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_reload_sound_devices(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_set_playback_device(IntPtr core, byte[] id);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_set_capture_device(IntPtr core, byte[] id);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_set_ringer_device(IntPtr core, byte[] id);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_get_capture_device(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_zrtp_secrets_file(IntPtr core, byte[] f);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_user_certificates_path(IntPtr core, byte[] f);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_audio_jittcomp(IntPtr core, int ms);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_inc_timeout(IntPtr core, int seconds);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_lime_x3dh(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_friend_list_subscription(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_push_notification_enabled(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_enable_push_notification(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_max_size_for_auto_download_incoming_files(IntPtr core, int size);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_network_reachable(IntPtr core, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_refresh_registers(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_terminate_all_calls(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_create_call_params(IntPtr core, IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_invite_with_params(IntPtr core, byte[] url, IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_create_nat_policy(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_create_account_params(IntPtr core);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_core_create_account(IntPtr core, IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_core_add_account(IntPtr core, IntPtr account);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_set_default_account(IntPtr core, IntPtr account);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_core_add_auth_info(IntPtr core, IntPtr info);
    // ---- account / nat policy / address
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_account_params_set_identity_address(IntPtr p, IntPtr addr);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_account_params_set_server_address(IntPtr p, IntPtr addr);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_enable_register(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_enable_publish(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_enable_outbound_proxy(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_enable_unregister_at_stop(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_set_push_notification_allowed(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_set_remote_push_notification_allowed(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_set_expires(IntPtr p, int seconds);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_set_nat_policy(IntPtr p, IntPtr policy);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_params_unref(IntPtr p);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_account_get_error_info(IntPtr account);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_account_unref(IntPtr account);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_nat_policy_enable_stun(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_nat_policy_enable_turn(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_nat_policy_enable_ice(IntPtr p, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_nat_policy_set_stun_server(IntPtr p, byte[] server);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_nat_policy_unref(IntPtr p);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_auth_info_unref(IntPtr p);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_error_info_get_protocol_code(IntPtr e);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_error_info_get_phrase(IntPtr e);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_address_as_string_uri_only(IntPtr a);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_address_get_display_name(IntPtr a);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_address_set_display_name(IntPtr a, byte[] name);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_address_get_username(IntPtr a);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_address_get_domain(IntPtr a);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_address_set_transport(IntPtr a, int transport);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_address_unref(IntPtr a);
    // ---- call
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_accept_with_params(IntPtr call, IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_terminate(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_decline(IntPtr call, int reason);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_get_reason(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_error_info(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_current_params(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_audio_stats(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_remote_address(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_to_address(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_get_authentication_token(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_ref(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_unref(IntPtr call);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_params_get_media_encryption(IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_params_set_media_encryption(IntPtr prm, int e);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_call_params_get_used_audio_payload_type(IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_params_enable_video(IntPtr prm, byte b);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_params_set_account(IntPtr prm, IntPtr account);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_params_unref(IntPtr prm);
    [DllImport(LL, CallingConvention = C)] public static extern IntPtr linphone_payload_type_get_mime_type(IntPtr pt);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_payload_type_get_clock_rate(IntPtr pt);
    [DllImport(LL, CallingConvention = C)] public static extern int linphone_call_stats_get_srtp_suite(IntPtr st);
    [DllImport(LL, CallingConvention = C)] public static extern void linphone_call_stats_unref(IntPtr st);
}

// ------------------------------------------------------------------------------------------------ JSON (strict, minimal)
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
            if (digits == 0) throw new FormatException("bad number at " + start);
            if (I < s.Length && s[I] == '.') { I++; int f = 0; while (I < s.Length && s[I] >= '0' && s[I] <= '9') { I++; f++; } if (f == 0) throw new FormatException("bad number at " + start); }
            if (I < s.Length && (s[I] == 'e' || s[I] == 'E'))
            {
                I++;
                if (I < s.Length && (s[I] == '+' || s[I] == '-')) I++;
                int e = 0; while (I < s.Length && s[I] >= '0' && s[I] <= '9') { I++; e++; }
                if (e == 0) throw new FormatException("bad number at " + start);
            }
            return double.Parse(s.Substring(start, I - start), CultureInfo.InvariantCulture);
        }

        string Str()
        {
            I++; // opening quote
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

    /// <summary>One event line: Ev("call", "call", id, "state", "ended"). Values are string, int, long, bool or null.</summary>
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
            else if (v is int || v is long) sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
            else sb.Append(Quote(v.ToString()));
        }
        sb.Append('}');
        return sb.ToString();
    }

    public static string Str(Dictionary<string, object> d, string key, bool required)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) { if (required) throw new FormatException("\"" + key + "\" is required"); return null; }
        if (!(v is string)) throw new FormatException("\"" + key + "\" must be a string");
        return (string)v;
    }
    public static bool Bool(Dictionary<string, object> d, string key, bool fallback)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        if (!(v is bool)) throw new FormatException("\"" + key + "\" must be true or false");
        return (bool)v;
    }
    public static int Int(Dictionary<string, object> d, string key, int fallback, int min, int max)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        if (!(v is double)) throw new FormatException("\"" + key + "\" must be a number");
        double x = (double)v;
        if (x != Math.Floor(x) || x < min || x > max) throw new FormatException("\"" + key + "\" is out of range");
        return (int)x;
    }
}

// ------------------------------------------------------------------------------------------------ output
static class Diag
{
    static readonly object gate = new object();
    /// <summary>Diagnostics go to stderr. Never a password, never audio.</summary>
    public static void Log(string text)
    {
        lock (gate)
        {
            try { Console.Error.WriteLine("nexus-sip: " + text); } catch (Exception) { }
        }
    }
}

/// <summary>Hands lines to stdout from its own thread, so that nothing on the media thread ever waits for the host.</summary>
class LineWriter
{
    class Item { public string Line; public bool Audio; }
    readonly Stream stream;
    readonly LinkedList<Item> queue = new LinkedList<Item>();
    int audioCount;
    bool closing, warned, broken;
    readonly Thread thread;
    const int MaxAudioFrames = 100; // 2 s of 20 ms

    public LineWriter(Stream s)
    {
        stream = s;
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Name = "stdout";
        thread.Start();
    }

    public void Post(string line, bool audio)
    {
        lock (queue)
        {
            if (closing || broken) return;
            Item it = new Item(); it.Line = line; it.Audio = audio;
            queue.AddLast(it);
            if (audio)
            {
                audioCount++;
                while (audioCount > MaxAudioFrames)
                {
                    // the host does not read: the oldest received sound is dropped, the newest is kept
                    LinkedListNode<Item> n = queue.First;
                    while (n != null && !n.Value.Audio) n = n.Next;
                    if (n == null) break;
                    queue.Remove(n);
                    audioCount--;
                    if (!warned) { warned = true; Diag.Log("the host stopped reading for more than 2 s: received audio is being dropped"); }
                }
            }
            Monitor.Pulse(queue);
        }
    }

    void Run()
    {
        while (true)
        {
            List<Item> batch = new List<Item>();
            lock (queue)
            {
                while (queue.Count == 0 && !closing) Monitor.Wait(queue);
                if (queue.Count == 0 && closing) return;
                while (queue.Count > 0 && batch.Count < 256)
                {
                    Item it = queue.First.Value;
                    queue.RemoveFirst();
                    if (it.Audio) audioCount--;
                    batch.Add(it);
                }
            }
            try
            {
                MemoryStream ms = new MemoryStream();
                foreach (Item it in batch)
                {
                    byte[] b = Encoding.UTF8.GetBytes(it.Line);
                    ms.Write(b, 0, b.Length);
                    ms.WriteByte(10);
                }
                byte[] all = ms.ToArray();
                stream.Write(all, 0, all.Length);
                stream.Flush();
            }
            catch (Exception)
            {
                lock (queue) { broken = true; queue.Clear(); }
                return;
            }
        }
    }

    public bool Broken { get { lock (queue) { return broken; } } }

    /// <summary>Writes what is queued and stops, waiting at most the given time.</summary>
    public void Close(int waitMs)
    {
        lock (queue) { closing = true; Monitor.PulseAll(queue); }
        thread.Join(waitMs);
    }
}

// ------------------------------------------------------------------------------------------------ sound card in managed code
// Struct layouts mirrored from linphone-sdk 5.5.32 win64 headers (mssndcard.h, msfilter.h, ortp/str_utils.h).
static class M
{
    const string MS = "mediastreamer2.dll";
    const string OR = "ortp.dll";
    const CallingConvention C = CallingConvention.Cdecl;
    [DllImport(MS, CallingConvention = C)] public static extern IntPtr ms_factory_get_snd_card_manager(IntPtr factory);
    [DllImport(MS, CallingConvention = C)] public static extern void ms_snd_card_manager_register_desc(IntPtr mgr, IntPtr desc);
    [DllImport(MS, CallingConvention = C)] public static extern void ms_snd_card_manager_add_card(IntPtr mgr, IntPtr card);
    [DllImport(MS, CallingConvention = C)] public static extern IntPtr ms_snd_card_new_with_name(IntPtr desc, byte[] name);
    [DllImport(MS, CallingConvention = C)] public static extern IntPtr ms_snd_card_get_factory(IntPtr card);
    [DllImport(MS, CallingConvention = C)] public static extern IntPtr ms_factory_create_filter_from_desc(IntPtr factory, IntPtr desc);
    [DllImport(OR, CallingConvention = C)] public static extern IntPtr allocb(UIntPtr size, int pri);
    [DllImport(OR, CallingConvention = C)] public static extern IntPtr getq(IntPtr q);
    [DllImport(OR, CallingConvention = C)] public static extern void putq(IntPtr q, IntPtr m);
    [DllImport(OR, CallingConvention = C)] public static extern void freemsg(IntPtr m);
}

[UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void FilterFn(IntPtr f);
[UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int MethodFn(IntPtr f, IntPtr arg);
[UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void DetectFn(IntPtr mgr);
[UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr CardFn(IntPtr card);

[StructLayout(LayoutKind.Sequential)]
struct MSFilterDescS            // struct _MSFilterDesc, 104 bytes on x64
{
    public int id;              // MSFilterId (MS_FILTER_PLUGIN_ID = 1)
    public IntPtr name;
    public IntPtr text;
    public int category;        // MS_FILTER_OTHER = 0
    public IntPtr enc_fmt;
    public int ninputs;
    public int noutputs;
    public IntPtr init, preprocess, process, postprocess, uninit;
    public IntPtr methods;
    public uint flags;
}

[StructLayout(LayoutKind.Sequential)]
struct MSFilterMethodS          // struct _MSFilterMethod, 16 bytes on x64
{
    public uint id;
    public IntPtr method;
}

/// <summary>A growing ring of 16-bit samples (the queue of sound to play). Not synchronised: the caller locks.</summary>
class ShortRing
{
    short[] buf = new short[16000 * 4];
    int head, count;
    public const int Max = 16000 * 600; // ten minutes of speech is more than any one answer
    public int Count { get { return count; } }

    public bool Write(short[] src, int off, int n)
    {
        if (count + n > Max) return false;
        if (count + n > buf.Length)
        {
            int cap = buf.Length;
            while (cap < count + n) cap *= 2;
            short[] nb = new short[Math.Min(cap, Max)];
            ReadInto(nb, 0, count, false);
            buf = nb; head = 0;
        }
        int tail = (head + count) % buf.Length;
        int first = Math.Min(n, buf.Length - tail);
        Array.Copy(src, off, buf, tail, first);
        if (first < n) Array.Copy(src, off + first, buf, 0, n - first);
        count += n;
        return true;
    }

    void ReadInto(short[] dst, int off, int n, bool consume)
    {
        int first = Math.Min(n, buf.Length - head);
        Array.Copy(buf, head, dst, off, first);
        if (first < n) Array.Copy(buf, 0, dst, off + first, n - first);
        if (consume) { head = (head + n) % buf.Length; count -= n; }
    }

    public int Read(short[] dst, int n)
    {
        if (n > count) n = count;
        if (n > 0) ReadInto(dst, 0, n, true);
        return n;
    }

    public void Clear() { head = 0; count = 0; }
}

/// <summary>
/// One sound card that exists only in this process: what the call hears is what the host queued (silence when
/// nothing is queued, the clock never stops), and what the call plays is handed to the host in 20 ms frames.
/// </summary>
class PcmDevice
{
    public const int Rate = 16000;
    public const int Frame = 320; // 20 ms
    static readonly List<PcmDevice> All = new List<PcmDevice>();
    static IntPtr cardDesc, readerDesc, writerDesc;
    static DetectFn detectFn; static FilterFn readerFn, writerFn; static MethodFn setSr, getSr, setCh, getCh;
    static CardFn createReader, createWriter;
    static readonly List<object> keep = new List<object>();

    public int Id;
    public string Name;
    public IntPtr Factory;

    // ---- host -> call
    class MarkS { public string Name; public long Pos; }
    readonly object inLock = new object();
    readonly ShortRing inQ = new ShortRing();
    readonly List<MarkS> marks = new List<MarkS>();
    long enqueued, played;
    long readerT0, produced, lastTick;
    bool overflowWarned;
    /// <summary>Called, with the lock released, when playback reaches a mark (or the queue is cleared).</summary>
    public Action<string> OnPlayed;

    public void Play(short[] pcm, int off, int count)
    {
        lock (inLock)
        {
            if (inQ.Write(pcm, off, count)) enqueued += count;
            else if (!overflowWarned) { overflowWarned = true; Diag.Log("more than ten minutes of sound are queued: the excess is dropped"); }
        }
    }

    public void Mark(string name)
    {
        bool now;
        lock (inLock)
        {
            now = played >= enqueued;
            if (!now) { MarkS m = new MarkS(); m.Name = name; m.Pos = enqueued; marks.Add(m); }
        }
        if (now && OnPlayed != null) OnPlayed(name);
    }

    public void Clear()
    {
        List<MarkS> due;
        lock (inLock)
        {
            inQ.Clear();
            played = enqueued;
            due = new List<MarkS>(marks);
            marks.Clear();
        }
        Fire(due);
    }

    void Fire(List<MarkS> due)
    {
        if (due == null || OnPlayed == null) return;
        foreach (MarkS m in due) OnPlayed(m.Name);
    }

    // ---- call -> host
    readonly short[] acc = new short[Frame * 16];
    int accN;
    public volatile bool RxEnabled;
    /// <summary>Called on the media thread with the base64 of each 20 ms frame.</summary>
    public Action<string> OnFrame;
    public void ResetRx() { accN = 0; }

    public static PcmDevice Create(IntPtr factory, string name)
    {
        EnsureDescs();
        PcmDevice d = new PcmDevice();
        d.Id = All.Count; d.Name = name; d.Factory = factory;
        All.Add(d);
        return d;
    }

    static IntPtr Cstr(string s) { return Marshal.StringToHGlobalAnsi(s); }

    static IntPtr BuildMethods()
    {
        // ids from MS_FILTER_METHOD_ID(MS_FILTER_BASE_ID=2, index, sizeof(int)=4)
        MSFilterMethodS[] ms = new MSFilterMethodS[5];
        ms[0].id = 0x00020004; ms[0].method = Marshal.GetFunctionPointerForDelegate(setSr);   // MS_FILTER_SET_SAMPLE_RATE
        ms[1].id = 0x00020104; ms[1].method = Marshal.GetFunctionPointerForDelegate(getSr);   // MS_FILTER_GET_SAMPLE_RATE
        ms[2].id = 0x00020504; ms[2].method = Marshal.GetFunctionPointerForDelegate(getCh);   // MS_FILTER_GET_NCHANNELS
        ms[3].id = 0x00020604; ms[3].method = Marshal.GetFunctionPointerForDelegate(setCh);   // MS_FILTER_SET_NCHANNELS
        ms[4].id = 0; ms[4].method = IntPtr.Zero;
        int sz = Marshal.SizeOf(typeof(MSFilterMethodS));
        IntPtr p = Marshal.AllocHGlobal(sz * 5);
        for (int i = 0; i < 5; i++) Marshal.StructureToPtr(ms[i], new IntPtr(p.ToInt64() + i * sz), false);
        return p;
    }

    static IntPtr BuildFilterDesc(string name, int nin, int nout, FilterFn process)
    {
        MSFilterDescS d = new MSFilterDescS();
        d.id = 1; d.name = Cstr(name); d.text = Cstr(name); d.category = 0; d.enc_fmt = IntPtr.Zero;
        d.ninputs = nin; d.noutputs = nout;
        d.process = Marshal.GetFunctionPointerForDelegate(process);
        d.methods = BuildMethods();
        d.flags = 1; // MS_FILTER_IS_PUMP
        IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MSFilterDescS)));
        Marshal.StructureToPtr(d, p, false);
        return p;
    }

    static void EnsureDescs()
    {
        if (cardDesc != IntPtr.Zero) return;
        detectFn = Detect; readerFn = ReaderProcess; writerFn = WriterProcess;
        setSr = SetSampleRate; getSr = GetSampleRate; setCh = SetChannels; getCh = GetChannels;
        createReader = CreateReader; createWriter = CreateWriter;
        keep.Add(detectFn); keep.Add(readerFn); keep.Add(writerFn); keep.Add(setSr); keep.Add(getSr);
        keep.Add(setCh); keep.Add(getCh); keep.Add(createReader); keep.Add(createWriter);
        readerDesc = BuildFilterDesc("NexusPcmReader", 0, 1, readerFn);
        writerDesc = BuildFilterDesc("NexusPcmWriter", 1, 0, writerFn);
        // struct _MSSndCardDesc: driver_type + 18 function pointers
        IntPtr[] f = new IntPtr[19];
        f[0] = Cstr("NexusPcm");
        f[1] = Marshal.GetFunctionPointerForDelegate(detectFn);
        f[8] = Marshal.GetFunctionPointerForDelegate(createReader);
        f[9] = Marshal.GetFunctionPointerForDelegate(createWriter);
        cardDesc = Marshal.AllocHGlobal(19 * IntPtr.Size);
        Marshal.Copy(f, 0, cardDesc, 19);
    }

    public static IntPtr CardDesc { get { EnsureDescs(); return cardDesc; } }

    // ---- sound card callbacks
    static void Detect(IntPtr mgr)
    {
        try
        {
            IntPtr fac = Marshal.ReadIntPtr(mgr, 0);                 // MSSndCardManager.factory
            for (int i = 0; i < All.Count; i++)
            {
                PcmDevice d = All[i];
                if (d.Factory != fac) continue;
                IntPtr card = M.ms_snd_card_new_with_name(cardDesc, N.U(d.Name));
                if (Marshal.ReadIntPtr(card, 24) == IntPtr.Zero) Marshal.WriteIntPtr(card, 24, Cstr(d.Name)); // id
                Marshal.WriteInt32(card, 40, 3);                      // capabilities = CAPTURE | PLAYBACK
                Marshal.WriteInt32(card, 44, 10);                     // device_type = MS_SND_CARD_DEVICE_TYPE_UNKNOWN
                Marshal.WriteIntPtr(card, 48, new IntPtr(d.Id));      // MSSndCard.data  (our device index)
                Marshal.WriteInt32(card, 56, Rate);                   // preferred_sample_rate
                M.ms_snd_card_manager_add_card(mgr, card);
            }
        }
        catch (Exception e) { Diag.Log("sound card detection failed: " + e.GetType().Name); }
    }

    static IntPtr CreateFilter(IntPtr card, IntPtr desc)
    {
        int id = (int)Marshal.ReadIntPtr(card, 48).ToInt64();
        IntPtr f = M.ms_factory_create_filter_from_desc(M.ms_snd_card_get_factory(card), desc);
        Marshal.WriteIntPtr(f, 48, new IntPtr(id));                   // MSFilter.data
        return f;
    }
    static IntPtr CreateReader(IntPtr card) { try { return CreateFilter(card, readerDesc); } catch (Exception) { return IntPtr.Zero; } }
    static IntPtr CreateWriter(IntPtr card) { try { return CreateFilter(card, writerDesc); } catch (Exception) { return IntPtr.Zero; } }

    static PcmDevice Dev(IntPtr f) { return All[(int)Marshal.ReadIntPtr(f, 48).ToInt64()]; }

    // ---- filter methods: the stream asks for its rate; the card says 16 kHz mono and mediastreamer2 resamples
    static int SetSampleRate(IntPtr f, IntPtr arg) { return 0; }
    static int GetSampleRate(IntPtr f, IntPtr arg) { Marshal.WriteInt32(arg, Rate); return 0; }
    static int SetChannels(IntPtr f, IntPtr arg) { return 0; }
    static int GetChannels(IntPtr f, IntPtr arg) { Marshal.WriteInt32(arg, 1); return 0; }

    // ---- process functions (called on the mediastreamer2 ticker thread every 10 ms)
    static void ReaderProcess(IntPtr f)
    {
        try
        {
            PcmDevice d = Dev(f);
            IntPtr outs = Marshal.ReadIntPtr(f, 24);                  // MSFilter.outputs
            if (outs == IntPtr.Zero) return;
            IntPtr q = Marshal.ReadIntPtr(outs, 0);
            if (q == IntPtr.Zero) return;
            d.ReaderTick(q);
        }
        catch (Exception) { }
    }

    void ReaderTick(IntPtr q)
    {
        long now = Stopwatch.GetTimestamp();
        // a new stream (or one resumed after a pause): the clock starts again
        if (readerT0 == 0 || now - lastTick > Stopwatch.Frequency / 5) { readerT0 = now; produced = 0; }
        lastTick = now;
        long should = (now - readerT0) * Rate / Stopwatch.Frequency;
        long behind = should - produced;
        if (behind > Rate / 2) { produced = should - 160; behind = 160; }     // resync after a long stall
        int need = (int)(behind / 160) * 160;                                  // whole 10 ms granules
        if (need <= 0) return;
        short[] buf = new short[need];
        int got;
        List<MarkS> due = null;
        lock (inLock)
        {
            got = inQ.Read(buf, need);
            played += got;
            if (marks.Count > 0)
            {
                int k = 0;
                while (k < marks.Count && marks[k].Pos <= played) k++;
                if (k > 0) { due = marks.GetRange(0, k); marks.RemoveRange(0, k); }
            }
        }
        // what was not queued is silence: the clock of the stream keeps running
        IntPtr m = M.allocb(new UIntPtr((uint)(need * 2)), 0);
        IntPtr w = Marshal.ReadIntPtr(m, 40);                                  // mblk_t.b_wptr
        Marshal.Copy(buf, 0, w, need);
        Marshal.WriteIntPtr(m, 40, new IntPtr(w.ToInt64() + need * 2));
        M.putq(q, m);
        produced += need;
        Fire(due);
    }

    static void WriterProcess(IntPtr f)
    {
        try
        {
            PcmDevice d = Dev(f);
            IntPtr ins = Marshal.ReadIntPtr(f, 16);                   // MSFilter.inputs
            if (ins == IntPtr.Zero) return;
            IntPtr q = Marshal.ReadIntPtr(ins, 0);
            if (q == IntPtr.Zero) return;
            IntPtr m;
            while ((m = M.getq(q)) != IntPtr.Zero)
            {
                for (IntPtr c = m; c != IntPtr.Zero; c = Marshal.ReadIntPtr(c, 16))   // b_cont
                {
                    long r = Marshal.ReadIntPtr(c, 32).ToInt64(), w = Marshal.ReadIntPtr(c, 40).ToInt64();
                    int n = (int)((w - r) / 2);
                    if (n <= 0 || !d.RxEnabled) continue;
                    d.Rx(new IntPtr(r), n);
                }
                M.freemsg(m);
            }
        }
        catch (Exception) { }
    }

    void Rx(IntPtr src, int n)
    {
        int done = 0;
        while (done < n)
        {
            int take = Math.Min(n - done, acc.Length - accN);
            Marshal.Copy(new IntPtr(src.ToInt64() + done * 2), acc, accN, take);
            accN += take; done += take;
            int used = 0;
            while (accN - used >= Frame)
            {
                byte[] bytes = new byte[Frame * 2];
                Buffer.BlockCopy(acc, used * 2, bytes, 0, bytes.Length);
                used += Frame;
                Action<string> sink = OnFrame;
                if (sink != null) sink(Convert.ToBase64String(bytes));
            }
            if (used > 0) { Array.Copy(acc, used, acc, 0, accN - used); accN -= used; }
        }
    }
}

// ------------------------------------------------------------------------------------------------ one SIP endpoint
class Endpoint
{
    public readonly string Name;
    readonly string runtime, state;
    readonly Sink sink;
    IntPtr core, cbs, account;
    PcmDevice pcm;
    int menc;
    bool mandatory, wantRegister, registered;
    string transportCfg = "udp", acctUser, acctDomain;
    // the one call
    IntPtr cur;
    volatile string curId;
    int nextId;
    string lastState, lastMedia, endOverride;
    bool localEnd, incoming;
    DateTime incomingAt, lastPoll = DateTime.MinValue;
    volatile bool audioActive;
    string lastErr;
    public volatile bool QuitRequested;

    static readonly Dictionary<IntPtr, Endpoint> ByCore = new Dictionary<IntPtr, Endpoint>();
    static CallStateCb stateCb; static CallEncCb encCb; static RegCb regCb; static DtmfCb dtmfCb;
    static bool dirsDone;

    public Endpoint(string name, string runtimeDir, string stateDir, Sink output)
    {
        Name = name; runtime = runtimeDir; state = stateDir; sink = output;
    }

    void Emit(string line) { sink(line, false); }
    void Err(string message) { Emit(Json.Ev("error", "message", message)); }
    void ErrOnce(string message) { if (message == lastErr) return; lastErr = message; Err(message); }

    // ---------------------------------------------------------------- setup
    string Dir(string sub)
    {
        string p = Path.Combine(state, sub);
        Directory.CreateDirectory(p);
        return p;
    }

    void SetupFactoryDirs(IntPtr f)
    {
        if (dirsDone) return;
        dirsDone = true;
        string share = Path.Combine(runtime, "share");
        string empty = Dir("empty");
        N.linphone_factory_set_top_resources_dir(f, N.U(share));
        N.linphone_factory_set_data_resources_dir(f, N.U(Path.Combine(share, "linphone")));
        N.linphone_factory_set_sound_resources_dir(f, N.U(empty));
        N.linphone_factory_set_ring_resources_dir(f, N.U(empty));
        N.linphone_factory_set_image_resources_dir(f, N.U(empty));
        N.linphone_factory_set_msplugins_dir(f, N.U(empty));
        N.linphone_factory_set_liblinphone_plugins_dir(f, N.U(empty));
        N.linphone_factory_set_config_dir(f, N.U(Dir("cfg")));
        N.linphone_factory_set_data_dir(f, N.U(Dir("data")));
        N.linphone_factory_set_cache_dir(f, N.U(Dir("cache")));
        N.linphone_factory_set_download_dir(f, N.U(Dir("download")));
        N.linphone_factory_enable_log_collection(f, 0);   // no log files, no upload
        N.linphone_logging_service_set_log_level(N.linphone_logging_service_get(), 16); // errors only
    }

    static void EnsureCallbacks()
    {
        if (stateCb != null) return;
        stateCb = OnCallStateStatic; encCb = OnEncStatic; regCb = OnRegStatic; dtmfCb = OnDtmfStatic;
    }

    public void Configure(Dictionary<string, object> c)
    {
        if (core != IntPtr.Zero) { Err("already configured"); return; }
        string transport = Json.Str(c, "transport", false) ?? "udp";
        if (transport != "tls" && transport != "tcp" && transport != "udp") throw new FormatException("\"transport\" must be tls, tcp or udp");
        string enc = Json.Str(c, "mediaEncryption", false) ?? "none";
        menc = enc == "none" ? 0 : enc == "srtp" ? 1 : enc == "zrtp" ? 2 : enc == "dtls" ? 3 : -1;
        if (menc < 0) throw new FormatException("\"mediaEncryption\" must be none, srtp, zrtp or dtls");
        mandatory = Json.Bool(c, "mediaEncryptionMandatory", false);
        string stun = Json.Str(c, "stunServer", false);
        bool ice = Json.Bool(c, "ice", false);
        int jitter = Json.Int(c, "jitterMs", 0, 0, 5000);
        wantRegister = Json.Bool(c, "register", true);
        int sipPort = Json.Int(c, "sipPort", -1, -1, 65535);
        string identity = Json.Str(c, "identity", wantRegister);
        string password = Json.Str(c, "password", false);
        string displayName = Json.Str(c, "displayName", false);
        string server = Json.Str(c, "server", wantRegister);
        if (wantRegister && string.IsNullOrEmpty(password)) throw new FormatException("\"password\" is required to register");
        c["password"] = null;          // not kept here any longer than needed
        transportCfg = transport;

        IntPtr f = N.linphone_factory_get();
        SetupFactoryDirs(f);
        EnsureCallbacks();
        core = N.linphone_factory_create_core_3(f, null, null, IntPtr.Zero);   // no configuration file: nothing is read, nothing kept
        if (core == IntPtr.Zero) { Err("the SIP core could not be created"); return; }
        ByCore[core] = this;
        cbs = N.linphone_factory_create_core_cbs(f);
        N.linphone_core_cbs_set_call_state_changed(cbs, stateCb);
        N.linphone_core_cbs_set_call_encryption_changed(cbs, encCb);
        N.linphone_core_cbs_set_account_registration_state_changed(cbs, regCb);
        N.linphone_core_cbs_set_dtmf_received(cbs, dtmfCb);
        N.linphone_core_add_callbacks(core, cbs);

        IntPtr t = N.linphone_factory_create_transports(f);
        N.linphone_transports_set_udp_port(t, transport == "udp" ? sipPort : 0);
        N.linphone_transports_set_tcp_port(t, transport == "tcp" ? sipPort : 0);
        N.linphone_transports_set_tls_port(t, transport == "tls" ? sipPort : 0);
        N.linphone_core_set_transports(core, t);
        N.linphone_transports_unref(t);

        N.linphone_core_set_user_agent(core, N.U("NEXUS Director"), N.U("1"));
        N.linphone_core_set_root_ca(core, N.U(Path.Combine(runtime, "share", "linphone", "rootca.pem")));
        N.linphone_core_enable_video_capture(core, 0);
        N.linphone_core_enable_video_display(core, 0);
        N.linphone_core_set_native_ringing_enabled(core, 0);
        N.linphone_core_enable_echo_cancellation(core, 0);
        N.linphone_core_enable_echo_limiter(core, 0);
        N.linphone_core_set_inc_timeout(core, 60);     // ours (45 s) comes first
        if (jitter > 0) N.linphone_core_set_audio_jittcomp(core, jitter);
        // everything that would reach a network other than SIP, STUN/TURN and media
        N.linphone_core_enable_lime_x3dh(core, 0);
        N.linphone_core_enable_friend_list_subscription(core, 0);
        N.linphone_core_set_push_notification_enabled(core, 0);
        N.linphone_core_enable_push_notification(core, 0);
        N.linphone_core_set_max_size_for_auto_download_incoming_files(core, -1);

        N.linphone_core_set_media_encryption(core, menc);
        N.linphone_core_set_media_encryption_mandatory(core, (byte)(mandatory ? 1 : 0));
        if (menc == 2) N.linphone_core_set_zrtp_secrets_file(core, N.U(Path.Combine(state, "zrtp-" + Name + ".db")));
        if (menc == 3) N.linphone_core_set_user_certificates_path(core, N.U(Dir("certs")));

        // the sound card: ours, for capture, playback and ringing, so that no real device is ever opened
        IntPtr fac = N.linphone_core_get_ms_factory(core);
        pcm = PcmDevice.Create(fac, "NexusPcm" + Name);
        pcm.OnPlayed = delegate (string mark) { string id = curId; if (id != null) Emit(Json.Ev("played", "call", id, "name", mark)); };
        pcm.OnFrame = delegate (string b64)
        {
            string id = curId;
            if (id != null && audioActive) sink("{\"e\":\"audio\",\"call\":\"" + id + "\",\"pcm\":\"" + b64 + "\"}", true);
        };
        IntPtr mgr = M.ms_factory_get_snd_card_manager(fac);
        M.ms_snd_card_manager_register_desc(mgr, PcmDevice.CardDesc);
        N.linphone_core_reload_sound_devices(core);
        byte[] dev = N.U("NexusPcm: NexusPcm" + Name);
        N.linphone_core_set_capture_device(core, dev);
        N.linphone_core_set_playback_device(core, dev);
        N.linphone_core_set_ringer_device(core, dev);

        int started = N.linphone_core_start(core);
        if (started != 0) { Err("the SIP core did not start"); return; }

        // With an identity there is an account. Without registration it is only what a call says it is from (a test
        // between two cores on this PC); with registration it is the account NEXUS is reachable at.
        if (identity != null)
        {
            IntPtr idAddr = N.linphone_factory_create_address(f, N.U(identity));
            IntPtr srvAddr = N.linphone_factory_create_address(f, N.U(wantRegister ? server : "sip:" + N.S(N.linphone_address_get_domain(idAddr))));
            if (idAddr == IntPtr.Zero || srvAddr == IntPtr.Zero) { Err("the identity or the server is not a SIP address"); return; }
            if (displayName != null) N.linphone_address_set_display_name(idAddr, N.U(displayName));
            if (wantRegister && server.IndexOf("transport=", StringComparison.OrdinalIgnoreCase) < 0)
                N.linphone_address_set_transport(srvAddr, transport == "tls" ? 2 : transport == "tcp" ? 1 : 0);
            acctUser = N.S(N.linphone_address_get_username(idAddr));
            acctDomain = N.S(N.linphone_address_get_domain(idAddr));
            IntPtr ap = N.linphone_core_create_account_params(core);
            N.linphone_account_params_set_identity_address(ap, idAddr);
            N.linphone_account_params_set_server_address(ap, srvAddr);
            N.linphone_account_params_enable_outbound_proxy(ap, (byte)(wantRegister ? 1 : 0));
            N.linphone_account_params_enable_register(ap, (byte)(wantRegister ? 1 : 0));
            N.linphone_account_params_enable_publish(ap, 0);
            N.linphone_account_params_set_push_notification_allowed(ap, 0);
            N.linphone_account_params_set_remote_push_notification_allowed(ap, 0);
            N.linphone_account_params_enable_unregister_at_stop(ap, 1);
            N.linphone_account_params_set_expires(ap, 600);
            if (stun != null || ice)
            {
                IntPtr nat = N.linphone_core_create_nat_policy(core);
                N.linphone_nat_policy_enable_turn(nat, 0);
                N.linphone_nat_policy_enable_stun(nat, (byte)(stun != null ? 1 : 0));
                N.linphone_nat_policy_enable_ice(nat, (byte)(ice ? 1 : 0));
                if (stun != null) N.linphone_nat_policy_set_stun_server(nat, N.U(stun));
                N.linphone_account_params_set_nat_policy(ap, nat);
                N.linphone_nat_policy_unref(nat);
            }
            if (wantRegister)
            {
                IntPtr auth = N.linphone_factory_create_auth_info(f, N.U(acctUser), null, N.U(password), null, null, N.U(acctDomain));
                N.linphone_core_add_auth_info(core, auth);
                N.linphone_auth_info_unref(auth);
            }
            password = null;
            account = N.linphone_core_create_account(core, ap);
            if (N.linphone_core_add_account(core, account) != 0) { Err("the account could not be added"); return; }
            N.linphone_core_set_default_account(core, account);
            N.linphone_account_params_unref(ap);
            N.linphone_address_unref(idAddr);
            N.linphone_address_unref(srvAddr);
            if (wantRegister) Emit(Json.Ev("registration", "state", "progress", "reason", null));
        }
    }

    // ---------------------------------------------------------------- commands
    /// <summary>Audio, clear and mark are queued in the order they arrive, straight from the reading thread.</summary>
    public bool HandleFast(string cmd, Dictionary<string, object> c)
    {
        if (cmd != "audio" && cmd != "clear" && cmd != "mark") return false;
        string id = Json.Str(c, "call", true);
        if (pcm == null || id != curId) { ErrOnce("no such call: " + id); return true; }
        if (cmd == "audio")
        {
            string b64 = Json.Str(c, "pcm", true);
            byte[] bytes;
            try { bytes = Convert.FromBase64String(b64); }
            catch (FormatException) { throw new FormatException("\"pcm\" is not base64"); }
            if (bytes.Length % 2 != 0) throw new FormatException("\"pcm\" is not whole 16-bit samples");
            short[] s = new short[bytes.Length / 2];
            Buffer.BlockCopy(bytes, 0, s, 0, bytes.Length);
            pcm.Play(s, 0, s.Length);
        }
        else if (cmd == "clear") pcm.Clear();
        else pcm.Mark(Json.Str(c, "name", true));
        return true;
    }

    public void Handle(string cmd, Dictionary<string, object> c)
    {
        if (HandleFast(cmd, c)) return;
        switch (cmd)
        {
            case "configure": Configure(c); break;
            case "call": Place(Json.Str(c, "to", true)); break;
            case "answer": Answer(Json.Str(c, "call", true)); break;
            case "decline": Decline(Json.Str(c, "call", true)); break;
            case "hangup": Hangup(Json.Str(c, "call", true)); break;
            case "refresh": Refresh(); break;
            case "quit": QuitRequested = true; break;
            default: throw new FormatException("unknown command");
        }
    }

    bool NeedCore()
    {
        if (core != IntPtr.Zero) return true;
        Err("not configured");
        return false;
    }

    IntPtr NewParams(IntPtr call)
    {
        IntPtr prm = N.linphone_core_create_call_params(core, call);
        N.linphone_call_params_enable_video(prm, 0);
        N.linphone_call_params_set_media_encryption(prm, menc);
        return prm;
    }

    void Place(string to)
    {
        if (!NeedCore()) return;
        if (cur != IntPtr.Zero) { Emit(Json.Ev("call", "call", "none", "state", "error", "reason", "busy")); return; }
        if (!to.StartsWith("sip:", StringComparison.OrdinalIgnoreCase) && !to.StartsWith("sips:", StringComparison.OrdinalIgnoreCase)) throw new FormatException("\"to\" must be a SIP address");
        IntPtr prm = NewParams(IntPtr.Zero);
        if (account != IntPtr.Zero) N.linphone_call_params_set_account(prm, account);
        IntPtr call = N.linphone_core_invite_with_params(core, N.U(to), prm);
        N.linphone_call_params_unref(prm);
        if (call == IntPtr.Zero && cur == IntPtr.Zero) Emit(Json.Ev("call", "call", "none", "state", "error", "reason", "invalid"));
    }

    void Answer(string id)
    {
        if (!NeedCore()) return;
        if (cur == IntPtr.Zero || id != curId || !incoming || lastState != null) { Err("no incoming call " + id); return; }
        IntPtr prm = NewParams(cur);
        N.linphone_call_accept_with_params(cur, prm);
        N.linphone_call_params_unref(prm);
        lastState = "answering";
    }

    void Decline(string id)
    {
        if (!NeedCore()) return;
        if (cur == IntPtr.Zero || id != curId || !incoming || lastState != null) { Err("no incoming call " + id); return; }
        localEnd = true;
        N.linphone_call_decline(cur, 3);
    }

    void Hangup(string id)
    {
        if (!NeedCore()) return;
        if (cur == IntPtr.Zero || id != curId) { Err("no such call " + id); return; }
        localEnd = true;
        if (incoming && lastState == null) N.linphone_call_decline(cur, 3);
        else N.linphone_call_terminate(cur);
    }

    void Refresh()
    {
        if (!NeedCore()) return;
        // the network came back, possibly with another address: the stack is told it went and returned, then registers anew
        N.linphone_core_set_network_reachable(core, 0);
        N.linphone_core_set_network_reachable(core, 1);
        if (wantRegister) N.linphone_core_refresh_registers(core);
    }

    // ---------------------------------------------------------------- the loop
    public void Tick()
    {
        if (core == IntPtr.Zero) return;
        N.linphone_core_iterate(core);
        DateTime now = DateTime.UtcNow;
        if (cur != IntPtr.Zero)
        {
            if (incoming && lastState == null && (now - incomingAt).TotalSeconds > 45)
            {
                endOverride = "timeout";
                localEnd = true;
                N.linphone_call_decline(cur, 3);
            }
            if (cur != IntPtr.Zero && lastState == "streams" && (now - lastPoll).TotalMilliseconds > 250)
            {
                lastPoll = now;
                ReportMedia();
            }
        }
    }

    public void Shutdown()
    {
        if (core == IntPtr.Zero) return;
        try
        {
            if (cur != IntPtr.Zero)
            {
                localEnd = true;
                N.linphone_core_terminate_all_calls(core);
                DateTime end = DateTime.UtcNow.AddMilliseconds(800);
                while (cur != IntPtr.Zero && DateTime.UtcNow < end) { N.linphone_core_iterate(core); Thread.Sleep(10); }
            }
            audioActive = false;
            if (pcm != null) { pcm.RxEnabled = false; pcm.Clear(); }
            N.linphone_core_stop(core);     // unregisters the account
            ByCore.Remove(core);
            N.linphone_core_unref(core);
        }
        catch (Exception e) { Diag.Log("shutdown: " + e.GetType().Name); }
        core = IntPtr.Zero;
    }

    // ---------------------------------------------------------------- callbacks (all on the thread that iterates)
    static void OnCallStateStatic(IntPtr c, IntPtr call, int st, IntPtr msg) { Endpoint e; if (ByCore.TryGetValue(c, out e)) e.OnCallState(call, st, N.S(msg)); }
    static void OnEncStatic(IntPtr c, IntPtr call, byte on, IntPtr token) { Endpoint e; if (ByCore.TryGetValue(c, out e) && call == e.cur) e.ReportMedia(); }
    static void OnRegStatic(IntPtr c, IntPtr acct, int st, IntPtr msg) { Endpoint e; if (ByCore.TryGetValue(c, out e)) e.OnReg(acct, st, N.S(msg)); }
    static void OnDtmfStatic(IntPtr c, IntPtr call, int dtmf) { Endpoint e; if (ByCore.TryGetValue(c, out e) && call == e.cur) e.OnDtmf(dtmf); }

    void OnDtmf(int d)
    {
        char ch = (char)d;
        if ((ch >= '0' && ch <= '9') || ch == '*' || ch == '#' || (ch >= 'A' && ch <= 'D'))
            Emit(Json.Ev("dtmf", "call", curId, "digit", ch.ToString()));
    }

    void OnReg(IntPtr acct, int st, string message)
    {
        if (st == 5) return;                         // refreshing: still registered
        string name = st == 1 ? "progress" : st == 2 ? "ok" : st == 3 ? "cleared" : st == 4 ? "failed" : "none";
        registered = st == 2;
        string reason = null;
        if (st == 4)
        {
            IntPtr ei = N.linphone_account_get_error_info(acct);
            if (ei != IntPtr.Zero)
            {
                int code = N.linphone_error_info_get_protocol_code(ei);
                string phrase = N.S(N.linphone_error_info_get_phrase(ei));
                if (code > 0) reason = code.ToString(CultureInfo.InvariantCulture) + (phrase != null ? " " + phrase : "");
            }
            if (reason == null) reason = message;
        }
        Emit(Json.Ev("registration", "state", name, "reason", reason));
    }

    static string ReasonName(int r)
    {
        switch (r)
        {
            case 0: return null;
            case 1: return "no_response";
            case 2: return "forbidden";
            case 3: return "declined";
            case 4: return "not_found";
            case 5: return "no_answer";
            case 6: return "busy";
            case 7: return "unsupported_media";
            case 9: return "network";
            case 10: return "declined";
            case 11: return "unauthorized";
            case 12: return "not_acceptable";
            case 16: return "unavailable";
            case 19: return "bad_gateway";
            case 21: return "server_timeout";
            default: return "reason_" + r;
        }
    }

    void CallEvent(string st, string reason) { Emit(Json.Ev("call", "call", curId, "state", st, "reason", reason)); }

    void OnCallState(IntPtr call, int st, string message)
    {
        if (st == 1)   // IncomingReceived
        {
            if (cur != IntPtr.Zero) { N.linphone_call_decline(call, 6); return; }   // one call at a time: busy
            Adopt(call, true);
            IntPtr from = N.linphone_call_get_remote_address(call);
            IntPtr uri = N.linphone_address_as_string_uri_only(from);
            string fromText = N.S(uri);
            if (uri != IntPtr.Zero) N.bctbx_free(uri);
            string display = N.S(N.linphone_address_get_display_name(from));
            Emit(Json.Ev("incoming", "call", curId, "from", fromText, "fromDisplayName", display, "viaRegisteredAccount", ViaRegisteredAccount(call)));
            return;
        }
        if (st == 3 && cur == IntPtr.Zero)   // OutgoingInit
        {
            Adopt(call, false);
            lastState = "outgoing";
            CallEvent("outgoing", null);
            return;
        }
        if (call != cur) return;
        switch (st)
        {
            case 5: case 6: if (lastState != "ringing") { lastState = "ringing"; CallEvent("ringing", null); } break;
            case 7: if (lastState != "connected" && lastState != "streams") { lastState = "connected"; CallEvent("connected", null); } break;
            case 8:
                if (lastState != "streams")
                {
                    lastState = "streams";
                    pcm.ResetRx();
                    pcm.RxEnabled = true;
                    audioActive = true;
                    CallEvent("streams", null);
                    ReportMedia();
                }
                break;
            case 13:
            case 14:
                string reason = endOverride ?? ReasonName(N.linphone_call_get_reason(call));
                if (reason == null) reason = localEnd ? "local" : (st == 13 ? (message ?? "failed") : "remote");
                audioActive = false;
                pcm.RxEnabled = false;
                string ended = st == 13 ? "error" : "ended";
                CallEvent(ended, reason);
                pcm.Clear();                      // anything still queued is gone; every mark is answered
                N.linphone_call_unref(cur);
                cur = IntPtr.Zero;
                curId = null;
                break;
        }
    }

    void Adopt(IntPtr call, bool inbound)
    {
        cur = N.linphone_call_ref(call);
        curId = "c" + (++nextId).ToString(CultureInfo.InvariantCulture);
        incoming = inbound;
        incomingAt = DateTime.UtcNow;
        lastState = null; lastMedia = null; endOverride = null; localEnd = false; lastErr = null;
        audioActive = false;
        pcm.Clear();
    }

    bool ViaRegisteredAccount(IntPtr call)
    {
        // The call was addressed to the account this core registered (its user and domain), and registration is ok.
        // A call made straight to an address and port of this PC carries the address of this PC instead.
        if (!registered || acctUser == null || acctDomain == null) return false;
        IntPtr to = N.linphone_call_get_to_address(call);
        if (to == IntPtr.Zero) return false;
        string user = N.S(N.linphone_address_get_username(to));
        string domain = N.S(N.linphone_address_get_domain(to));
        return user != null && domain != null
            && string.Equals(user, acctUser, StringComparison.OrdinalIgnoreCase)
            && string.Equals(domain, acctDomain, StringComparison.OrdinalIgnoreCase);
    }

    static readonly string[] SrtpSuites = new string[] {
        "AES_CM_128_HMAC_SHA1_80", "AES_CM_128_HMAC_SHA1_32", "AES_192_CM_HMAC_SHA1_80", "AES_192_CM_HMAC_SHA1_32",
        "AES_256_CM_HMAC_SHA1_80", "AES_256_CM_HMAC_SHA1_32", "AEAD_AES_128_GCM", "AEAD_AES_256_GCM" };

    void ReportMedia()
    {
        if (cur == IntPtr.Zero) return;
        IntPtr prm = N.linphone_call_get_current_params(cur);
        if (prm == IntPtr.Zero) return;
        int enc = N.linphone_call_params_get_media_encryption(prm);
        IntPtr pt = N.linphone_call_params_get_used_audio_payload_type(prm);
        string codec = pt == IntPtr.Zero ? "unknown" : (N.S(N.linphone_payload_type_get_mime_type(pt)) ?? "unknown").ToLowerInvariant();
        int rate = pt == IntPtr.Zero ? 0 : N.linphone_payload_type_get_clock_rate(pt);
        string sas = null;
        if (enc == 2)
        {
            sas = N.S(N.linphone_call_get_authentication_token(cur));
            if (string.IsNullOrEmpty(sas)) sas = null;
        }
        string suite = null;
        IntPtr stats = N.linphone_call_get_audio_stats(cur);
        if (stats != IntPtr.Zero)
        {
            int s = N.linphone_call_stats_get_srtp_suite(stats);
            if (s >= 0 && s < SrtpSuites.Length && enc != 0) suite = SrtpSuites[s];
            N.linphone_call_stats_unref(stats);
        }
        string encName = enc == 1 ? "srtp" : enc == 2 ? "zrtp" : enc == 3 ? "dtls" : "none";
        string key = codec + "|" + rate + "|" + encName + "|" + sas + "|" + suite;
        if (key == lastMedia) return;
        lastMedia = key;
        Emit(Json.Ev("media", "call", curId, "codec", codec, "clockRate", rate, "encryption", encName, "zrtpSas", sas, "srtpSuite", suite));
    }
}

// ------------------------------------------------------------------------------------------------ the program
static class Program
{
    static string runtimeDir, stateDir;

    static int Main(string[] args)
    {
        // First, before anything else: no Windows error dialog may appear in an unattended run.
        N.SetErrorMode(0x8003);
        bool selftest = false;
        string enc = "none";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--runtime" && i + 1 < args.Length) runtimeDir = Path.GetFullPath(args[++i]);
            else if (args[i] == "--state" && i + 1 < args.Length) stateDir = Path.GetFullPath(args[++i]);
            else if (args[i] == "--selftest") selftest = true;
            else if (args[i] == "--enc" && i + 1 < args.Length) enc = args[++i];
            else return Usage();
        }
        if (runtimeDir == null) return Usage();
        if (!selftest && stateDir == null) return Usage();
        if (!File.Exists(Path.Combine(runtimeDir, "liblinphone.dll"))) { Console.Error.WriteLine("nexus-sip: liblinphone.dll is not in " + runtimeDir); return 3; }
        if (stateDir == null) stateDir = Path.Combine(Path.GetDirectoryName(typeof(Program).Assembly.Location), "selftest-state");
        N.SetDllDirectory(runtimeDir);
        N.timeBeginPeriod(1);
        try
        {
            return selftest ? SelfTest.Run(runtimeDir, stateDir, enc) : Serve();
        }
        catch (DllNotFoundException e) { Console.Error.WriteLine("nexus-sip: the runtime could not be loaded: " + e.Message); return 3; }
        catch (BadImageFormatException) { Console.Error.WriteLine("nexus-sip: the runtime is not 64-bit"); return 3; }
    }

    static int Usage()
    {
        Console.Error.WriteLine("usage: nexus-sip --runtime <dir> --state <dir>   |   nexus-sip --selftest --runtime <dir> [--state <dir>] [--enc none|srtp|zrtp|dtls]");
        return 2;
    }

    // ---------------------------------------------------------------- the protocol
    static readonly object queueLock = new object();
    static readonly List<KeyValuePair<string, Dictionary<string, object>>> pending = new List<KeyValuePair<string, Dictionary<string, object>>>();
    static volatile bool inputClosed;

    static Stream OwnStdout()
    {
        // The protocol gets a private duplicate of standard output; standard output itself is then pointed at standard
        // error, so that whatever a native library prints can never be mistaken for an event.
        IntPtr h = N.GetStdHandle(-11), dup;
        if (h == IntPtr.Zero || h == new IntPtr(-1)) throw new IOException("no standard output");
        if (!N.DuplicateHandle(N.GetCurrentProcess(), h, N.GetCurrentProcess(), out dup, 0, false, 2)) throw new IOException("standard output could not be duplicated");
        try { N._dup2(2, 1); } catch (Exception) { }
        return new FileStream(new SafeFileHandle(dup, true), FileAccess.Write, 1, false);
    }

    static int Serve()
    {
        Stream stdout = OwnStdout();
        LineWriter writer = new LineWriter(stdout);
        Endpoint ep = new Endpoint("nexus", runtimeDir, stateDir, writer.Post);
        string version = N.S(N.linphone_core_get_version());
        writer.Post(Json.Ev("ready", "version", version), false);

        Thread reader = new Thread(delegate () { ReadInput(ep, writer); });
        reader.IsBackground = true;
        reader.Name = "stdin";
        reader.Start();

        while (!ep.QuitRequested && !inputClosed)
        {
            List<KeyValuePair<string, Dictionary<string, object>>> work = null;
            lock (queueLock) { if (pending.Count > 0) { work = new List<KeyValuePair<string, Dictionary<string, object>>>(pending); pending.Clear(); } }
            if (work != null)
            {
                foreach (KeyValuePair<string, Dictionary<string, object>> w in work)
                {
                    try { ep.Handle(w.Key, w.Value); }
                    catch (FormatException e) { writer.Post(Json.Ev("error", "message", w.Key + ": " + e.Message), false); }
                    catch (Exception e) { writer.Post(Json.Ev("error", "message", w.Key + " failed: " + e.GetType().Name), false); }
                }
            }
            if (writer.Broken) break;
            try { ep.Tick(); } catch (Exception e) { Diag.Log("tick: " + e.GetType().Name); }
            Thread.Sleep(5);
        }
        // Quit or end of input: whatever happens, the process is gone within 3 s.
        Thread watchdog = new Thread(delegate () { Thread.Sleep(2800); Environment.Exit(0); });
        watchdog.IsBackground = true;
        watchdog.Start();
        ep.Shutdown();
        writer.Close(200);
        return 0;
    }

    static void ReadInput(Endpoint ep, LineWriter writer)
    {
        UTF8Encoding strict = new UTF8Encoding(false, true);
        Stream stdin = Console.OpenStandardInput();
        byte[] buf = new byte[8192];
        MemoryStream line = new MemoryStream();
        bool overflow = false;
        while (true)
        {
            int n;
            try { n = stdin.Read(buf, 0, buf.Length); } catch (Exception) { break; }
            if (n <= 0) break;
            for (int i = 0; i < n; i++)
            {
                byte c = buf[i];
                if (c == 10)
                {
                    if (overflow) { writer.Post(Json.Ev("error", "message", "a line longer than 64 KB was refused"), false); overflow = false; }
                    else if (line.Length > 0) HandleLine(ep, writer, strict, line.ToArray());
                    line.SetLength(0);
                }
                else if (!overflow)
                {
                    if (line.Length >= 65536) { overflow = true; line.SetLength(0); }
                    else line.WriteByte(c);
                }
            }
        }
        inputClosed = true;
    }

    static void HandleLine(Endpoint ep, LineWriter writer, UTF8Encoding strict, byte[] bytes)
    {
        string cmd = null;
        try
        {
            string text = strict.GetString(bytes).TrimEnd('\r');
            if (text.Trim().Length == 0) return;
            Dictionary<string, object> d = Json.Parse(text) as Dictionary<string, object>;
            if (d == null) throw new FormatException("a line must be a JSON object");
            cmd = Json.Str(d, "c", true);
            if (ep.HandleFast(cmd, d)) return;
            if (cmd == "quit") { ep.QuitRequested = true; return; }
            lock (queueLock) { pending.Add(new KeyValuePair<string, Dictionary<string, object>>(cmd, d)); }
        }
        catch (FormatException e) { writer.Post(Json.Ev("error", "message", (cmd != null ? cmd + ": " : "") + e.Message), false); }
        catch (ArgumentException) { writer.Post(Json.Ev("error", "message", "a line is not valid UTF-8"), false); }
        catch (Exception e) { writer.Post(Json.Ev("error", "message", "a line was not understood: " + e.GetType().Name), false); }
    }
}

// ------------------------------------------------------------------------------------------------ self-test
static class SelfTest
{
    static readonly List<string> a = new List<string>(), b = new List<string>();
    static int failures;

    static void Check(bool ok, string what, string detail)
    {
        if (!ok) failures++;
        Console.WriteLine((ok ? "PASS " : "FAIL ") + what + (detail != null ? " (" + detail + ")" : ""));
    }

    static int FreePort()
    {
        UdpClient u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        int p = ((IPEndPoint)u.Client.LocalEndPoint).Port;
        u.Close();
        return p;
    }

    static void Send(Endpoint e, string line)
    {
        Dictionary<string, object> d = (Dictionary<string, object>)Json.Parse(line);
        e.Handle((string)d["c"], d);
    }

    static string Find(List<string> list, string needle) { lock (list) { foreach (string s in list) if (s.IndexOf(needle, StringComparison.Ordinal) >= 0) return s; } return null; }
    static string Field(string json, string key)
    {
        Dictionary<string, object> d = (Dictionary<string, object>)Json.Parse(json);
        object v; return d.TryGetValue(key, out v) && v != null ? v.ToString() : null;
    }

    static bool Pump(Endpoint x, Endpoint y, int ms, Func<bool> until)
    {
        DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < end)
        {
            x.Tick(); y.Tick();
            if (until != null && until()) return true;
            Thread.Sleep(5);
        }
        return until == null;
    }

    static double Goertzel(short[] x, int off, int n, double hz)
    {
        double w = 2 * Math.PI * hz / 16000.0, c = 2 * Math.Cos(w), s1 = 0, s2 = 0;
        for (int i = 0; i < n; i++) { double s0 = x[off + i] + c * s1 - s2; s2 = s1; s1 = s0; }
        return 2 * Math.Sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / n;
    }
    static double Rms(short[] x, int off, int n) { double t = 0; for (int i = 0; i < n; i++) t += (double)x[off + i] * x[off + i]; return n > 0 ? Math.Sqrt(t / n) : 0; }

    /// <summary>The audio events of one endpoint, in order, with the time each arrived.</summary>
    static List<KeyValuePair<long, short[]>> Frames(List<string> list, int from)
    {
        List<KeyValuePair<long, short[]>> r = new List<KeyValuePair<long, short[]>>();
        lock (list)
        {
            for (int i = from; i < list.Count; i++)
            {
                string s = list[i];
                if (!s.StartsWith("{\"e\":\"audio\"", StringComparison.Ordinal)) continue;
                int k = s.IndexOf("\"pcm\":\"", StringComparison.Ordinal) + 7;
                byte[] bytes = Convert.FromBase64String(s.Substring(k, s.IndexOf('"', k) - k));
                short[] pcm = new short[bytes.Length / 2];
                Buffer.BlockCopy(bytes, 0, pcm, 0, bytes.Length);
                r.Add(new KeyValuePair<long, short[]>(0, pcm));
            }
        }
        return r;
    }

    public static int Run(string runtime, string state, string enc)
    {
        Console.WriteLine("liblinphone " + N.S(N.linphone_core_get_version()) + ", encryption " + enc);
        Endpoint ea = new Endpoint("a", runtime, state, delegate (string l, bool au) { lock (a) a.Add(l); });
        Endpoint eb = new Endpoint("b", runtime, state, delegate (string l, bool au) { lock (b) b.Add(l); });
        int pa = FreePort(), pb = FreePort();
        string mand = enc == "none" ? "false" : "true";
        string cfg = "{\"c\":\"configure\",\"register\":false,\"identity\":\"sip:IDENT@nexus.test\",\"transport\":\"udp\",\"mediaEncryption\":\"" + enc + "\",\"mediaEncryptionMandatory\":" + mand + ",\"sipPort\":";
        Send(ea, cfg.Replace("IDENT", "caller") + pa + "}");
        Send(eb, cfg.Replace("IDENT", "callee") + pb + "}");
        Pump(ea, eb, 400, null);
        Send(ea, "{\"c\":\"call\",\"to\":\"sip:127.0.0.1:" + pb + "\"}");
        bool inc = Pump(ea, eb, 8000, delegate { return Find(b, "\"e\":\"incoming\"") != null; });
        Check(inc, "incoming call reaches the other core", null);
        if (!inc) return Finish(ea, eb);
        string incoming = Find(b, "\"e\":\"incoming\"");
        string idB = Field(incoming, "call"), idA = Field(Find(a, "\"state\":\"outgoing\""), "call");
        Check(Field(incoming, "viaRegisteredAccount") == "False" && Field(incoming, "from") == "sip:caller@nexus.test", "incoming event names the caller and is not via an account", Field(incoming, "from"));
        Pump(ea, eb, 700, null);
        Check(Find(b, "\"state\":\"streams\"") == null, "an incoming call is not answered by itself", null);
        Send(eb, "{\"c\":\"answer\",\"call\":\"" + idB + "\"}");
        bool streams = Pump(ea, eb, 15000, delegate { return Find(a, "\"state\":\"streams\"") != null && Find(b, "\"state\":\"streams\"") != null; });
        Check(streams, "both ends reach streams", null);
        if (!streams) return Finish(ea, eb);
        if (enc != "none")
        {
            string want = "\"encryption\":\"" + enc + "\"";
            bool secured = Pump(ea, eb, 10000, delegate { return Find(a, want) != null && Find(b, want) != null; });
            Check(secured, "media reports " + enc + " on both ends", Find(a, want));
            if (enc == "zrtp") Check(Find(a, "\"zrtpSas\":\"") != null, "a ZRTP short authentication string is reported", null);
        }
        Pump(ea, eb, 600, null);

        // tone from a to b
        int mark = 0; lock (b) mark = b.Count;
        short[] tone = new short[16000 * 2];
        for (int i = 0; i < tone.Length; i++) tone[i] = (short)(0.5 * 32767 * Math.Sin(2 * Math.PI * 440 * i / 16000.0));
        byte[] tb = new byte[tone.Length * 2];
        Buffer.BlockCopy(tone, 0, tb, 0, tb.Length);
        Stopwatch sw = Stopwatch.StartNew();
        for (int off = 0; off < tb.Length; off += 640)
        {
            byte[] fr = new byte[Math.Min(640, tb.Length - off)];
            Buffer.BlockCopy(tb, off, fr, 0, fr.Length);
            Send(ea, "{\"c\":\"audio\",\"call\":\"" + idA + "\",\"pcm\":\"" + Convert.ToBase64String(fr) + "\"}");
        }
        Send(ea, "{\"c\":\"mark\",\"call\":\"" + idA + "\",\"name\":\"tone\"}");
        long firstMs = -1;
        Pump(ea, eb, 4000, delegate
        {
            if (firstMs < 0)
            {
                List<KeyValuePair<long, short[]>> fs = Frames(b, mark);
                foreach (KeyValuePair<long, short[]> f in fs) if (Rms(f.Value, 0, f.Value.Length) > 1500) { firstMs = sw.ElapsedMilliseconds; break; }
            }
            return false;
        });
        List<KeyValuePair<long, short[]>> frames = Frames(b, mark);
        List<short> all = new List<short>();
        foreach (KeyValuePair<long, short[]> f in frames) all.AddRange(f.Value);
        short[] rx = all.ToArray();
        int start = -1;
        for (int i = 0; i + 160 <= rx.Length; i += 160) if (Rms(rx, i, 160) > 1500) { start = i; break; }
        bool toneOk = false; string detail = "no tone heard";
        if (start >= 0 && start + 4800 + 16000 <= rx.Length)
        {
            double g440 = Goertzel(rx, start + 4800, 16000, 440), g1000 = Goertzel(rx, start + 4800, 16000, 1000);
            toneOk = g440 > 0.8 * 0.5 * 32767 && g440 < 1.2 * 0.5 * 32767 && g1000 < 0.02 * g440;
            detail = "amp@440=" + g440.ToString("0", CultureInfo.InvariantCulture) + " amp@1000=" + g1000.ToString("0", CultureInfo.InvariantCulture) + " first sound after " + firstMs + " ms";
        }
        Check(toneOk, "a 440 Hz tone sent on one side is received on the other", detail);
        Check(Find(a, "\"e\":\"played\"") != null, "mark answered when playback reached it", null);

        // clear
        Send(ea, "{\"c\":\"mark\",\"call\":\"" + idA + "\",\"name\":\"before\"}");
        short[] long1k = new short[16000 * 10];
        for (int i = 0; i < long1k.Length; i++) long1k[i] = (short)(0.5 * 32767 * Math.Sin(2 * Math.PI * 1000 * i / 16000.0));
        byte[] lb = new byte[long1k.Length * 2];
        Buffer.BlockCopy(long1k, 0, lb, 0, lb.Length);
        Send(ea, "{\"c\":\"audio\",\"call\":\"" + idA + "\",\"pcm\":\"" + Convert.ToBase64String(lb) + "\"}");
        Send(ea, "{\"c\":\"mark\",\"call\":\"" + idA + "\",\"name\":\"long\"}");
        Pump(ea, eb, 1200, null);
        int before; lock (a) before = a.Count;
        Send(ea, "{\"c\":\"clear\",\"call\":\"" + idA + "\"}");
        bool markFired = false; lock (a) { for (int i = before; i < a.Count; i++) if (a[i].IndexOf("\"name\":\"long\"", StringComparison.Ordinal) >= 0) markFired = true; }
        Check(markFired, "clear answers the mark that was waiting", null);
        int mark2; lock (b) mark2 = b.Count;
        Pump(ea, eb, 1500, null);
        List<KeyValuePair<long, short[]>> after = Frames(b, mark2);
        double tail = 0; int cnt = 0;
        for (int i = Math.Max(0, after.Count - 25); i < after.Count; i++) { tail = Math.Max(tail, Rms(after[i].Value, 0, after[i].Value.Length)); cnt++; }
        Check(cnt > 0 && tail < 300, "sound stops after clear (last 500 ms are silent)", "peak rms " + tail.ToString("0", CultureInfo.InvariantCulture));

        // hang up
        Send(ea, "{\"c\":\"hangup\",\"call\":\"" + idA + "\"}");
        bool ended = Pump(ea, eb, 6000, delegate { return Find(a, "\"state\":\"ended\"") != null && Find(b, "\"state\":\"ended\"") != null; });
        Check(ended, "hangup ends the call on both sides", null);
        return Finish(ea, eb);
    }

    static int Finish(Endpoint ea, Endpoint eb)
    {
        ea.Shutdown(); eb.Shutdown();
        Console.WriteLine(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL");
        return failures == 0 ? 0 : 1;
    }
}
