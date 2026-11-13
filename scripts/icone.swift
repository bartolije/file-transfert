// Régénère build/icon.icns depuis build/icon.svg : rendu vectoriel à chaque taille, fond transparent.
// Usage (macOS 14+) : swift scripts/icone.swift
import AppKit

guard let svg = NSImage(contentsOfFile: "build/icon.svg") else { fatalError("build/icon.svg introuvable") }
let set = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("file-transfert-\(getpid()).iconset")
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: set) }

func render(_ n: Int, _ name: String) throws {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current!.imageInterpolation = .high
  svg.draw(in: NSRect(x: 0, y: 0, width: n, height: n))
  NSGraphicsContext.restoreGraphicsState()
  try rep.representation(using: .png, properties: [:])!.write(to: set.appendingPathComponent(name))
}

for n in [16, 32, 128, 256, 512] {
  try render(n, "icon_\(n)x\(n).png")
  try render(n * 2, "icon_\(n)x\(n)@2x.png")
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", set.path, "-o", "build/icon.icns"]
try p.run()
p.waitUntilExit()
if p.terminationStatus != 0 { fatalError("iconutil a échoué") }
print("build/icon.icns régénéré")
