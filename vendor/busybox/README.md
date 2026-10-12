# busybox-w32

`busybox.exe` is busybox-w32, build FRP-6075-g169694ebd (64-bit, Unicode), unmodified, from
https://frippery.org/files/busybox/busybox-w64u-FRP-6075-g169694ebd.exe

SHA-256: 6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c (as published in the site's SHA256SUM).

NEXUS uses it as the POSIX shell of the isolated profile: it is a native Windows program and runs inside the
AppContainer, where Git for Windows' bash cannot. NEXUS runs only a file with this hash
(`src/main/modules/isolation/shell-adapter.ts`).

License: GNU GPL version 2. Source: https://github.com/rmyorston/busybox-w32 at commit 169694ebd. Whoever
distributes a NEXUS installer that contains this file must offer that source with it.
