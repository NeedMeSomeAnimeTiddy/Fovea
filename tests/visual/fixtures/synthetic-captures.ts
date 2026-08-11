export type SyntheticCaptureKind = 'wide' | 'tall' | 'tiny' | 'desktop'

export function syntheticCaptureDataUrl(
  kind: SyntheticCaptureKind,
  width = dimensions[kind].width,
  height = dimensions[kind].height
): string {
  const title = ({
    wide: 'Synthetic wide report',
    tall: 'Synthetic tall document',
    tiny: 'Tiny fixture',
    desktop: 'Synthetic desktop'
  } satisfies Record<SyntheticCaptureKind, string>)[kind]
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const panelWidth = Math.max(40, Math.round(safeWidth * 0.42))
  const panelHeight = Math.max(32, Math.round(safeHeight * 0.56))
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#223047"/>
          <stop offset="1" stop-color="#48546a"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <circle cx="${Math.round(safeWidth * 0.82)}" cy="${Math.round(safeHeight * 0.18)}" r="${Math.max(12, Math.round(Math.min(safeWidth, safeHeight) * 0.09))}" fill="#7fc4ff" opacity=".58"/>
      <rect x="${Math.round(safeWidth * 0.08)}" y="${Math.round(safeHeight * 0.18)}" width="${panelWidth}" height="${panelHeight}" rx="${Math.max(8, Math.round(Math.min(safeWidth, safeHeight) * 0.02))}" fill="#f6f8fc"/>
      <rect x="${Math.round(safeWidth * 0.12)}" y="${Math.round(safeHeight * 0.29)}" width="${Math.round(panelWidth * 0.7)}" height="${Math.max(4, Math.round(safeHeight * 0.025))}" rx="4" fill="#276cb5"/>
      <rect x="${Math.round(safeWidth * 0.12)}" y="${Math.round(safeHeight * 0.38)}" width="${Math.round(panelWidth * 0.52)}" height="${Math.max(4, Math.round(safeHeight * 0.018))}" rx="4" fill="#aeb8c8"/>
      <rect x="${Math.round(safeWidth * 0.12)}" y="${Math.round(safeHeight * 0.45)}" width="${Math.round(panelWidth * 0.62)}" height="${Math.max(4, Math.round(safeHeight * 0.018))}" rx="4" fill="#c3cad5"/>
      <text x="${Math.round(safeWidth * 0.08)}" y="${Math.round(safeHeight * 0.12)}" fill="#fff" font-family="Segoe UI, sans-serif" font-size="${Math.max(10, Math.round(Math.min(safeWidth, safeHeight) * 0.035))}">${title}</text>
      <text x="${Math.round(safeWidth * 0.58)}" y="${Math.round(safeHeight * 0.72)}" fill="#d9e7f7" font-family="Segoe UI, sans-serif" font-size="${Math.max(8, Math.round(Math.min(safeWidth, safeHeight) * 0.024))}">Privacy-safe fixture</text>
    </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const dimensions: Record<SyntheticCaptureKind, { width: number; height: number }> = {
  wide: { width: 1600, height: 900 },
  tall: { width: 900, height: 1600 },
  tiny: { width: 64, height: 64 },
  desktop: { width: 1280, height: 720 }
}
