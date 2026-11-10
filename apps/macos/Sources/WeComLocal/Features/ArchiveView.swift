import AppKit
import SwiftUI

struct ArchiveView: View {
    @ObservedObject var archive: ArchiveModel
    @State private var section: ArchiveSection = .conversations

    var body: some View {
        VStack(spacing: 0) {
            if let error = archive.error {
                notice(error, icon: "exclamationmark.circle") { archive.error = nil }
            }
            if let result = archive.exported {
                HStack {
                    Label("已导出 \(result.files.count) 个 SQLite 数据库", systemImage: "checkmark.circle")
                    Button("在访达中显示") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: result.directory)])
                    }
                    Spacer()
                    dismiss { archive.exported = nil }
                }
                .padding(10)
                Divider()
            }
            content
            Divider()
            HStack {
                Label(archive.state.phase.title, systemImage: "bolt.horizontal.circle")
                Spacer()
                if let updated = archive.state.updatedAt {
                    Text("上次同步 \(updated.formatted(date: .omitted, time: .shortened))")
                }
                Label("本地只读", systemImage: "lock")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(10)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Menu {
                    ForEach(archive.profiles) { profile in
                        Button {
                            Task {
                                await archive.select(profile.id)
                                section = .conversations
                            }
                        } label: {
                            Label(profile.name, systemImage: profile.available ? "building.2" : "exclamationmark.circle")
                        }
                        .disabled(!profile.available)
                        .help(profile.issue.map { CoreError($0).localizedDescription } ?? profile.name)
                    }
                    if archive.profiles.isEmpty { Text("未找到企业档案") }
                } label: {
                    Label(archive.profiles.first { $0.id == archive.state.profile }?.name ?? "选择企业",
                          systemImage: "building.2")
                }
                .disabled(archive.selecting || archive.exporting)
            }
            ToolbarItem(placement: .principal) {
                Picker("页面", selection: $section) {
                    ForEach(ArchiveSection.allCases) { Text($0.rawValue).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await archive.scan() } } label: {
                    Label("重新扫描", systemImage: "arrow.clockwise")
                }
                .disabled(archive.scanning || archive.selecting)
                .help("重新扫描企业档案")

                Button { Task { await archive.export() } } label: {
                    Label("导出明文数据库", systemImage: "square.and.arrow.up")
                }
                .disabled(archive.state.updatedAt == nil || archive.selecting || archive.exporting)
                .help("导出明文数据库")
            }
        }
        .task { if archive.profiles.isEmpty { await archive.scan() } }
        .task { await archive.poll() }
    }

    @ViewBuilder private var content: some View {
        if section == .sync {
            Form {
                LabeledContent("同步状态", value: archive.state.phase.title)
                LabeledContent("会话", value: archive.state.counts.conversations.formatted())
                LabeledContent("联系人", value: archive.state.counts.contacts.formatted())
                LabeledContent("消息", value: archive.state.counts.messages.formatted())
                if archive.state.profile != nil {
                    Button(archive.pauseTitle) { Task { await archive.togglePause() } }
                }
                ForEach(archive.state.issues, id: \.self) { issue in
                    Label(CoreError(issue).localizedDescription, systemImage: "info.circle")
                }
            }
            .formStyle(.grouped)
        } else if let profile = archive.state.profile, archive.state.updatedAt != nil, !archive.selecting {
            BrowserView(core: archive.core, profile: profile, revision: archive.state.revision, section: section)
                .id(profile)
        } else {
            VStack(spacing: 12) {
                if archive.scanning || archive.selecting || archive.state.phase == .syncing { ProgressView() }
                else { Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle) }
                Text(welcome).font(.headline)
                if archive.state.phase == .retrying {
                    ForEach(archive.state.issues, id: \.self) { Text(CoreError($0).localizedDescription) }
                }
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var welcome: String {
        if archive.scanning { return "正在查找企业档案…" }
        if archive.selecting || archive.state.phase == .syncing { return "正在读取本地消息…" }
        if archive.state.phase == .retrying { return archive.state.phase.title }
        return archive.profiles.isEmpty ? "未找到本机企业档案" : "从工具栏选择一个企业档案"
    }

    private func notice(_ text: String, icon: String, close: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            HStack {
                Label(text, systemImage: icon)
                Spacer()
                dismiss(close)
            }
            .padding(10)
            Divider()
        }
    }

    private func dismiss(_ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: "xmark") }
            .buttonStyle(.borderless)
            .accessibilityLabel("关闭提示")
    }
}

enum ArchiveSection: String, CaseIterable, Identifiable {
    case conversations = "消息", contacts = "通讯录", sync = "同步"
    var id: Self { self }
}
