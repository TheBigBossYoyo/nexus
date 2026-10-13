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

Its source: https://github.com/rmyorston/busybox-w32 at commit 169694ebdba292f6533f78aeea678bfbb907396c (FRP-6075).
The complete source of that commit is in this repository, `source/busybox-w32-169694ebd.tar.gz` (its SHA-256
is in `PROVENANCE.json`): the whole tree, with the Makefiles and the configuration upstream builds this variant
from (`configs/mingw64u_defconfig`). NEXUS ships upstream's binary as it is and builds nothing of it.

Using it on your own machine asks nothing of you. **Giving a copy of NEXUS that contains it to anybody else**
(an installer, a zip) does: section 3 of the license. NEXUS takes the first of the license's three ways, 3(a):
the complete corresponding source goes with the binary. `scripts/release-artifacts.mjs` puts the archive in
`release/v<version>/source/` beside the installer, with the license text in `licenses/` and a statement in
`THIRD_PARTY_NOTICES.md`; it says "NOT distributable" when the archive is missing. A link to somebody else's
repository would not do, and no written offer is made (3(b)), so:

- whoever publishes or passes on the installer publishes or passes on the `source/` archive with it, from the
  same place;
- a build whose release folder lacks the archive is for the machine it was built on.

The packaged application carries this file and `COPYING` in `resources/bin/busybox-license/`. This is the
author's reading of the license, not legal advice.
