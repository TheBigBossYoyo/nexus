import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import type { TrayAction, TrayStatus } from './modules/overnight/tray-model'
import type { RuntimeTrayAction, RuntimeTrayStatus, TraySnapshot } from './modules/runtime/tray-model'

const COLORS: Record<TrayStatus | RuntimeTrayStatus, [number, number, number]> = {
  RUNNING: [72, 187, 120],
  PAUSED: [237, 181, 62],
  FINALIZING: [99, 161, 255],
  'SHUTDOWN SCHEDULED': [240, 82, 82],
  IDLE: [148, 156, 170],
  ATTENTION: [240, 140, 62],
  RECOVERING: [99, 161, 255],
}

/** A filled disc drawn in code: the build has no icon assets. */
function icon(status: TrayStatus | RuntimeTrayStatus): NativeImage {
  const size = 32
  const [r, g, b] = COLORS[status]
  const pixels = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre)
      const alpha = distance <= 13 ? 255 : distance <= 14 ? 128 : 0
      const i = (y * size + x) * 4
      // BGRA
      pixels[i] = b
      pixels[i + 1] = g
      pixels[i + 2] = r
      pixels[i + 3] = alpha
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 })
}

/**
 * The Windows tray icon of the NEXUS runtime. It exists while the runtime does, whether or not a window is
 * open, and says what the runtime is doing. During an overnight mission it shows that mission, as since 0.2,
 * with the runtime's own entries below.
 */
export class RuntimeTray {
  private tray: Tray | null = null

  constructor(
    private readonly read: () => TraySnapshot,
    private readonly onAction: (action: RuntimeTrayAction | TrayAction, runId?: string) => void,
  ) {}

  refresh(): void {
    let snapshot: TraySnapshot
    try {
      snapshot = this.read()
    } catch {
      return
    }
    const overnight = snapshot.overnight?.visible && snapshot.overnight.status && snapshot.overnight.runId ? snapshot.overnight : null
    const status = overnight?.status ?? snapshot.runtime.status
    if (!this.tray) {
      this.tray = new Tray(icon(status))
      this.tray.on('double-click', () => this.onAction('open'))
    } else this.tray.setImage(icon(status))
    this.tray.setToolTip(overnight ? overnight.tooltip : snapshot.runtime.tooltip)
    const runId = overnight?.runId ?? undefined
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(overnight ? overnight.lines : snapshot.runtime.lines).map((label) => ({ label, enabled: false })),
        { type: 'separator' as const },
        // The mission's own entries (pause, cancel shutdown, cancel mission); "Open NEXUS" comes from the runtime's.
        ...(overnight ? overnight.items.filter((item) => item.action !== 'open').map((item) => ({ label: item.label, enabled: item.enabled, click: () => this.onAction(item.action, runId) })) : []),
        ...(overnight ? [{ type: 'separator' as const }] : []),
        ...snapshot.runtime.items.map((item) => ({ label: item.label, enabled: item.enabled, click: () => this.onAction(item.action) })),
      ]),
    )
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
