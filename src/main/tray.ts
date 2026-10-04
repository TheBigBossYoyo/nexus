import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { buildTrayModel, type TrayAction, type TrayModel, type TrayStatus } from './modules/overnight/tray-model'
import type { TrayInput } from './modules/overnight/tray-model'

const COLORS: Record<TrayStatus, [number, number, number]> = {
  RUNNING: [72, 187, 120],
  PAUSED: [237, 181, 62],
  FINALIZING: [99, 161, 255],
  'SHUTDOWN SCHEDULED': [240, 82, 82],
}

/** A filled disc drawn in code: the build has no icon assets. */
function icon(status: TrayStatus): NativeImage {
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

/** Windows tray icon for Overnight Mode. Exists only while a mission needs the app to stay alive. */
export class OvernightTray {
  private tray: Tray | null = null
  private last: TrayModel | null = null

  constructor(
    private readonly read: () => TrayInput,
    private readonly onAction: (action: TrayAction, runId: string) => void,
  ) {}

  /** The model currently shown (tests read it through the app). */
  model(): TrayModel | null {
    return this.last
  }

  refresh(): void {
    const model = buildTrayModel(this.read())
    this.last = model
    if (!model.visible || model.status === null || model.runId === null) {
      this.tray?.destroy()
      this.tray = null
      return
    }
    const runId = model.runId
    if (!this.tray) {
      this.tray = new Tray(icon(model.status))
      this.tray.on('double-click', () => this.onAction('open', runId))
    } else {
      this.tray.setImage(icon(model.status))
    }
    this.tray.setToolTip(model.tooltip)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...model.lines.map((label) => ({ label, enabled: false })),
        { type: 'separator' as const },
        ...model.items.map((item) => ({ label: item.label, enabled: item.enabled, click: () => this.onAction(item.action, runId) })),
      ]),
    )
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
