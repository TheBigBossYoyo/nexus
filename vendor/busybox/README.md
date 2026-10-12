# busybox-w32

`busybox.exe` is busybox-w32, build FRP-6075-g169694ebd (64-bit, Unicode), unmodified, from
https://frippery.org/files/busybox/busybox-w64u-FRP-6075-g169694ebd.exe

SHA-256: 6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c (as published in the site's SHA256SUM).

NEXUS uses it as the POSIX shell of the isolated profile: it is a native Windows program and runs inside the
AppContainer, where Git for Windows' bash cannot. NEXUS runs only a file with this hash
(`src/main/modules/isolation/shell-adapter.ts`).

## License and what distributing it requires

busybox-w32 is under the GNU General Public License, version 2 (`COPYING` beside this file). NEXUS starts it as a
separate program and links nothing of it: the license covers this one file, not NEXUS.

Its source: https://github.com/rmyorston/busybox-w32 at commit 169694ebd (tag FRP-6075).

Using it on your own machine asks nothing of you. **Giving a copy of NEXUS that contains it to anybody else**
(an installer, a zip) does: section 3 of the license. Either the complete corresponding source goes with it,
or a written offer, valid for three years, to give that source to anyone who asks. A link to somebody else's
repository is neither. The simplest way to comply is to put the source archive of that commit beside the
installer wherever the installer is published. Until one of the two is done, NEXUS builds that contain this
file are for the machine they were built on. The packaged application carries this file and `COPYING` in
`resources/bin/busybox-license/`.
