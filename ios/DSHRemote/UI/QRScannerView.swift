import AVFoundation
import SwiftUI

struct QRScannerSheet: View {
    var onLink: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                QRScannerView { text in
                    guard let url = URL(string: text), let link = PairingLink(url: url) else {
                        message = L("这不是 DSH Remote 配对二维码。", "Not a DSH Remote pairing code.")
                        return false
                    }
                    onLink(link)
                    return true
                }
                .ignoresSafeArea()
                VStack(spacing: 8) {
                    Text(L("扫描电脑上 DSH Remote 管理页的二维码", "Scan the QR code on the DSH Remote admin page"))
                        .font(.subheadline.weight(.medium))
                    if let message { Text(message).font(.footnote).foregroundStyle(.orange) }
                }
                .padding(16)
                .dshGlass(in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                .padding(.bottom, 40)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("取消", "Cancel")) { dismiss() } }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }
}

/// Camera preview that reports QR payloads; the handler returns true to stop scanning.
struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Bool

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
    }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Bool)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var finished = false
        private var lastRejected: String?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async { granted ? self?.configure() : self?.showDenied() }
            }
        }

        private func configure() {
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else { return }
            session.beginConfiguration()
            if session.canAddInput(input) { session.addInput(input) }
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
            }
            session.commitConfiguration()
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }

        private func showDenied() {
            let label = UILabel()
            label.text = L("请在“设置”中允许 DSH Remote 使用相机。", "Allow camera access in Settings.")
            label.textColor = .white
            label.numberOfLines = 0
            label.textAlignment = .center
            label.frame = view.bounds.insetBy(dx: 24, dy: 0)
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(label)
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !finished, let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, code != lastRejected else { return }
            if onCode?(code) == true {
                finished = true
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                lastRejected = code
            }
        }
    }
}
