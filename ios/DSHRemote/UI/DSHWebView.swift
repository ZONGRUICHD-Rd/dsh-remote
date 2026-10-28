import SwiftUI
import UIKit
import WebKit

/// Owns the WKWebView that renders the DSH web client served by the PC.
/// Everything inside — chat, thinking/trajectory view, tools, approvals,
/// settings, plugin UIs — is DSH's own client, so it always matches the
/// desktop and picks up newly installed plugins on the next load.
@MainActor
final class WebController: NSObject, ObservableObject {
    @Published var pageBackground: UIColor?
    @Published var loadError: String?
    @Published var isLoading = false
    @Published var download: URL?
    weak var webView: WKWebView?
    @Published private(set) var loadedOnce = false

    func reload() {
        loadError = nil
        if webView?.url == nil, let url = pendingURL { webView?.load(URLRequest(url: url)) } else { webView?.reload() }
    }

    var pendingURL: URL?

    func load(_ url: URL) {
        pendingURL = url
        loadError = nil
        webView?.load(URLRequest(url: url))
    }

    fileprivate func markLoaded() { loadedOnce = true }
}

struct DSHWebView: UIViewRepresentable {
    let url: URL
    let localOrigin: URL
    let layout: LayoutMode
    let desktopWidth: Int
    @ObservedObject var controller: WebController

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, localOrigin: localOrigin) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.preferredContentMode = layout == .desktop ? .desktop : .mobile
        config.userContentController.add(context.coordinator, name: "dshRemote")
        config.userContentController.addUserScript(WKUserScript(source: Self.bootstrapScript(layout: layout, desktopWidth: desktopWidth),
                                                                injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.keyboardDismissMode = .interactive
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        controller.webView = webView
        controller.load(url)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "dshRemote")
    }

    /// Viewport for the selected layout, plus page-color reporting so the
    /// native safe areas blend with DSH's light/dark theme.
    static func bootstrapScript(layout: LayoutMode, desktopWidth: Int) -> String {
        let viewport = layout == .desktop
            ? "width=\(desktopWidth), viewport-fit=cover"
            : "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        return """
        (function () {
          window.__DSH_REMOTE__ = { platform: 'ios', layout: '\(layout.rawValue)' };
          function applyViewport() {
            var meta = document.querySelector('meta[name=viewport]');
            if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
            if (meta.content !== '\(viewport)') meta.content = '\(viewport)';
          }
          applyViewport();
          new MutationObserver(applyViewport).observe(document.head, { childList: true, subtree: true, attributes: true });
          var style = document.createElement('style');
          style.textContent = 'html{-webkit-text-size-adjust:100%;} body{-webkit-tap-highlight-color:transparent;overscroll-behavior:none;}';
          document.head.appendChild(style);
          var last = '';
          function report() {
            try {
              var root = document.querySelector('#root > *') || document.body;
              var color = getComputedStyle(root).backgroundColor;
              if (!color || color === 'rgba(0, 0, 0, 0)') color = getComputedStyle(document.body).backgroundColor;
              if (color && color !== last) { last = color; window.webkit.messageHandlers.dshRemote.postMessage({ type: 'background', color: color }); }
            } catch (e) {}
          }
          report();
          setInterval(report, 1500);
        })();
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let controller: WebController
        let localOrigin: URL
        private var downloadDestinations: [ObjectIdentifier: URL] = [:]

        init(controller: WebController, localOrigin: URL) {
            self.controller = controller
            self.localOrigin = localOrigin
        }

        private func isLocal(_ url: URL?) -> Bool {
            guard let url else { return false }
            if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return true }
            return url.host == localOrigin.host && url.port == localOrigin.port
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            guard let url = action.request.url else { decisionHandler(.allow); return }
            if isLocal(url) || action.targetFrame?.isMainFrame == false {
                decisionHandler(.allow)
                return
            }
            // Links to the outside world open in Safari, not inside the DSH shell.
            if ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let http = response.response as? HTTPURLResponse,
               let disposition = http.value(forHTTPHeaderField: "Content-Disposition"), disposition.lowercased().hasPrefix("attachment") {
                decisionHandler(.download)
                return
            }
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            Task { @MainActor in self.controller.isLoading = true }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                self.controller.isLoading = false
                self.controller.loadError = nil
                self.controller.markLoaded()
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // frame load interrupted by a download
            Task { @MainActor in
                self.controller.isLoading = false
                self.controller.loadError = error.localizedDescription
            }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: UI (alerts, confirms, prompts, new windows, media)

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if isLocal(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert, fallback: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: L("取消", "Cancel"), style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert) { completionHandler(false) }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: L("取消", "Cancel"), style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
            present(alert) { completionHandler(nil) }
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // Voice input in DSH: allow for the PC's own page only (the system still asks once).
            decisionHandler(origin.host == localOrigin.host && origin.port == (localOrigin.port ?? 0) ? .grant : .prompt)
        }

        private func present(_ controller: UIViewController, fallback: @escaping () -> Void) {
            guard let top = UIApplication.shared.topViewController else { fallback(); return }
            top.present(controller, animated: true)
        }

        // MARK: Script messages

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], body["type"] as? String == "background",
                  let css = body["color"] as? String, let color = UIColor(cssRGB: css) else { return }
            Task { @MainActor in self.controller.pageBackground = color }
        }

        // MARK: Downloads (session exports, files from tools)

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
            try? FileManager.default.removeItem(at: url)
            downloadDestinations[ObjectIdentifier(download)] = url
            completionHandler(url)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
            Task { @MainActor in self.controller.download = url }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        }
    }
}

extension UIColor {
    /// Parses `rgb(r, g, b)` / `rgba(r, g, b, a)` from getComputedStyle.
    convenience init?(cssRGB text: String) {
        let numbers = text.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).compactMap(Double.init)
        guard numbers.count >= 3 else { return nil }
        let alpha = numbers.count >= 4 ? numbers[3] : 1
        guard alpha > 0.5 else { return nil }
        self.init(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: 1)
    }
}

extension UIApplication {
    var topViewController: UIViewController? {
        let scene = connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive } ?? connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
