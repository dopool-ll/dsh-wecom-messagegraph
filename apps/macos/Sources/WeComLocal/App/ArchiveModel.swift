import AppKit
import SwiftUI

@MainActor
final class ArchiveModel: ObservableObject {
    let core: CoreClient
    @Published private(set) var profiles: [Profile] = []
    @Published private(set) var state = SyncState.initial
    @Published private(set) var scanning = false
    @Published private(set) var selecting = false
    @Published private(set) var exporting = false
    @Published var error: String?
    @Published var exported: DatabaseExport?

    var pauseTitle: String { state.phase == .paused ? "继续同步" : "暂停同步" }

    init(core: CoreClient = CoreClient()) {
        self.core = core
    }

    func scan() async {
        guard !scanning else { return }
        scanning = true
        error = nil
        defer { scanning = false }
        do { profiles = try await core.request(.init(op: .discover)) }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }

    func poll() async {
        while !Task.isCancelled {
            do {
                let status: SyncState = try await core.request(.init(op: .status))
                if !selecting && !Task.isCancelled { state = status }
            } catch is CancellationError { return }
            catch {
                if !Task.isCancelled && !selecting { self.error = error.localizedDescription }
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    func select(_ profile: String) async {
        guard profile != state.profile, !selecting, !exporting else { return }
        selecting = true
        error = nil
        exported = nil
        defer { selecting = false }
        do { state = try await core.request(.init(op: .select, id: profile)) }
        catch { self.error = error.localizedDescription }
    }

    func togglePause() async {
        guard state.profile != nil, !selecting else { return }
        do { state = try await core.request(.init(op: .pause, paused: state.phase != .paused)) }
        catch { self.error = error.localizedDescription }
    }

    func export() async {
        guard let profile = state.profile, state.updatedAt != nil, !selecting, !exporting else { return }
        exporting = true
        defer { exporting = false }
        let panel = NSOpenPanel()
        panel.title = "选择明文数据库的导出位置"
        panel.prompt = "导出"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        guard await panel.begin() == .OK, let url = panel.url else { return }

        do {
            error = nil
            exported = try await core.request(.init(op: .exportDatabases, profile: profile, directory: url.path))
        } catch { self.error = error.localizedDescription }
    }
}
