import AppKit
import SwiftUI

@main
struct WeComLocalApp: App {
    @Environment(\.openWindow) private var openWindow
    @StateObject private var archive = ArchiveModel()

    var body: some Scene {
        Window("企微本地消息", id: "archive") {
            ArchiveView(archive: archive)
                .frame(minWidth: 800, minHeight: 540)
        }
        .defaultSize(width: 1060, height: 720)

        MenuBarExtra("企微本地消息", systemImage: "bubble.left.and.bubble.right") {
            Button("打开企微本地消息") {
                openWindow(id: "archive")
                NSApp.activate(ignoringOtherApps: true)
            }
            if archive.state.profile != nil {
                Button(archive.pauseTitle) { Task { await archive.togglePause() } }
            }
            Divider()
            Button("退出") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}
