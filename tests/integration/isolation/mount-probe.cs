// What a contained process can ask of the Mount Manager and what it cannot do to it. Compiled by the test with the
// compiler that ships with Windows and run inside the containment. One line per question: name=OK:... or
// name=DENIED:<Windows error>. It changes nothing it could not undo itself: the mutations are asked for with
// empty requests on a handle that was opened without read or write access, and on a directory of its own.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Probe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(IntPtr h, uint code, byte[] input, int inputLength, byte[] output, int outputLength, out int returned, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeNameForVolumeMountPointW(string mountPoint, StringBuilder name, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetVolumeMountPointW(string mountPoint, string volumeName);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteVolumeMountPointW(string mountPoint);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDeviceW(uint flags, string device, string target);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    static readonly IntPtr Invalid = new IntPtr(-1);
    static void Say(string name, bool ok, string detail) { Console.WriteLine(name + "=" + (ok ? "OK:" : "DENIED:") + detail); }

    static int Main() {
        string here = Directory.GetCurrentDirectory();
        // Asking: the canonical form of a path, and the volume behind a drive letter.
        IntPtr dir = CreateFileW(here, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        StringBuilder path = new StringBuilder(1024);
        uint n = dir == Invalid ? 0 : GetFinalPathNameByHandleW(dir, path, 1024, 0);
        Say("canonical", n > 0, n > 0 ? path.ToString() : Marshal.GetLastWin32Error().ToString());
        if (dir != Invalid) CloseHandle(dir);
        StringBuilder volume = new StringBuilder(128);
        bool named = GetVolumeNameForVolumeMountPointW(Path.GetPathRoot(here), volume, 128);
        Say("volume-of-drive", named, named ? "found" : Marshal.GetLastWin32Error().ToString());

        // The device, as Windows itself opens it for a question: no read, no write.
        IntPtr ask = CreateFileW(@"\\.\MountPointManager", 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        Say("open-to-ask", ask != Invalid, ask != Invalid ? "opened" : Marshal.GetLastWin32Error().ToString());
        // With read and write, which every change needs.
        foreach (uint access in new uint[] { 0x80000000, 0x40000000, 0xC0000000, 0x00040000 }) {
            IntPtr h = CreateFileW(@"\\.\MountPointManager", access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            string name = access == 0x80000000 ? "open-to-read" : access == 0x40000000 ? "open-to-write" : access == 0xC0000000 ? "open-to-read-and-write" : "open-to-change-its-access-list";
            Say(name, h != Invalid, h != Invalid ? "opened" : Marshal.GetLastWin32Error().ToString());
            if (h != Invalid) CloseHandle(h);
        }
        if (ask != Invalid) {
            // Each change, asked for with an empty request on the handle that may only ask. Windows checks the
            // handle's access before the Mount Manager sees the request: what counts is error 5 (access denied).
            string[] names = { "create-mount-point", "delete-mount-points", "delete-from-database", "next-drive-letter", "automatic-drive-letters", "volume-arrival" };
            uint[] codes = { 0x6DC000, 0x6DC004, 0x6DC00C, 0x6DC010, 0x6DC014, 0x6DC02C };
            for (int i = 0; i < names.Length; i++) {
                int returned; byte[] buffer = new byte[64];
                bool done = DeviceIoControl(ask, codes[i], buffer, buffer.Length, buffer, buffer.Length, out returned, IntPtr.Zero);
                Say(names[i], done, done ? "accepted" : Marshal.GetLastWin32Error().ToString());
            }
            CloseHandle(ask);
        }
        // Through the documented calls, on a directory of its own.
        string mount = Path.Combine(here, "mnt-probe") + "\\";
        Directory.CreateDirectory(mount);
        bool set = named && SetVolumeMountPointW(mount, volume.ToString());
        Say("set-volume-mount-point", set, set ? "made" : Marshal.GetLastWin32Error().ToString());
        if (set) DeleteVolumeMountPointW(mount);
        bool deleted = DeleteVolumeMountPointW(mount);
        Say("delete-volume-mount-point", deleted, deleted ? "deleted" : Marshal.GetLastWin32Error().ToString());
        // A drive letter. DDD_RAW_TARGET_PATH (1): a name in the object namespace, as a drive assignment is.
        bool raw = DefineDosDeviceW(1, "Q:", @"\Device\HarddiskVolume1");
        Say("define-drive-raw", raw, raw ? "defined" : Marshal.GetLastWin32Error().ToString());
        if (raw) DefineDosDeviceW(1 | 2 | 4, "Q:", @"\Device\HarddiskVolume1");
        bool plain = DefineDosDeviceW(0, "Q:", here);
        Say("define-drive-for-own-directory", plain, plain ? "defined" : Marshal.GetLastWin32Error().ToString());
        if (plain) DefineDosDeviceW(2, "Q:", null);
        try { Directory.Delete(mount); } catch (Exception) { }
        return 0;
    }
}
