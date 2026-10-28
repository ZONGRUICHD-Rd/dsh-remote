// CI check: render a QR matrix produced by the bridge's encoder and decode it
// with Apple's CoreImage detector. Usage: swift decode-qr.swift matrix.txt "expected text"
import CoreImage
import Foundation

let args = CommandLine.arguments
let rows = try! String(contentsOfFile: args[1], encoding: .utf8).split(separator: "\n").map(String.init)
let expected = args[2]
let scale = 8
let border = 4
let size = (rows.count + 2 * border) * scale
var pixels = [UInt8](repeating: 255, count: size * size)
for (y, row) in rows.enumerated() {
    for (x, c) in row.enumerated() where c == "1" {
        for dy in 0..<scale {
            for dx in 0..<scale {
                pixels[((y + border) * scale + dy) * size + (x + border) * scale + dx] = 0
            }
        }
    }
}
let provider = CGDataProvider(data: Data(pixels) as CFData)!
let image = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let features = detector.features(in: CIImage(cgImage: image)).compactMap { $0 as? CIQRCodeFeature }
guard let decoded = features.first?.messageString else {
    print("FAIL: no QR code detected")
    exit(1)
}
guard decoded == expected else {
    print("FAIL: decoded \(decoded)")
    exit(1)
}
print("QR OK (\(rows.count)x\(rows.count)): \(decoded.prefix(60))")
