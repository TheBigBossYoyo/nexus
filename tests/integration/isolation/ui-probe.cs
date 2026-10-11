// A probe for the containment tests: run inside the containment, it says which desktop it is on, what it can
// do to desktops and the clipboard, and which handles it inherited. It changes nothing: a desktop it manages to
// make is closed at once, and it never switches to one.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Probe {
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint id);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h, int index, StringBuilder buffer, int size, out int needed);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr h, out uint flags);
    [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);

    static int Main() {
        StringBuilder name = new StringBuilder(256); int needed;
        IntPtr mine = GetThreadDesktop(GetCurrentThreadId());
        Console.WriteLine("desktop=" + (GetUserObjectInformationW(mine, 2 /* UOI_NAME */, name, 512, out needed) ? name.ToString() : "unknown:" + Marshal.GetLastWin32Error()));
        // The desktop the user is looking at, to read what is on it.
        IntPtr input = OpenInputDesktop(0, false, 0x1 /* DESKTOP_READOBJECTS */);
        Console.WriteLine("open-input-desktop=" + (input != IntPtr.Zero));
        if (input != IntPtr.Zero) CloseDesktop(input);
        IntPtr users = OpenDesktopW("Default", 0, false, 0x1 | 0x2 | 0x40 /* read objects, create window, enumerate */);
        Console.WriteLine("open-default-desktop=" + (users != IntPtr.Zero));
        if (users != IntPtr.Zero) CloseDesktop(users);
        IntPtr made = CreateDesktopW("nx-probe-" + GetCurrentThreadId(), IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
        Console.WriteLine("create-desktop=" + (made != IntPtr.Zero));
        if (made != IntPtr.Zero) CloseDesktop(made);
        bool clipboard = OpenClipboard(IntPtr.Zero);
        Console.WriteLine("open-clipboard=" + clipboard);
        if (clipboard) CloseClipboard();
        // Handles this process was given by inheritance: the inherit flag stays set on them.
        int inherited = 0; StringBuilder kinds = new StringBuilder();
        for (long value = 4; value < 0x8000; value += 4) {
            uint flags;
            if (!GetHandleInformation(new IntPtr(value), out flags) || (flags & 1) == 0) continue;
            inherited++;
            kinds.Append(GetFileType(new IntPtr(value))).Append(',');
        }
        Console.WriteLine("inherited-handles=" + inherited);
        Console.WriteLine("inherited-kinds=" + kinds);
        return 0;
    }
}
