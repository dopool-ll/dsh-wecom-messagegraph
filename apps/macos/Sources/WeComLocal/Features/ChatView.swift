import AppKit
import SwiftUI

struct ChatView: View {
    let core: CoreClient
    let profile: String
    let conversation: Conversation
    let revision: Int

    @State private var page = Page<Message>.empty
    @State private var paging = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(conversation.name).font(.headline)
                Text("\(conversation.count) 条本地消息 · \(scopeLabel(conversation.scope))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            Divider()
            if let error { Text(error).foregroundStyle(.secondary).padding(8) }

            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if page.more {
                            Button(paging ? "正在读取…" : "查看更早的消息") {
                                Task {
                                    let anchor = page.items.first?.id
                                    await loadOlder()
                                    if let anchor { scroll.scrollTo(anchor, anchor: .top) }
                                }
                            }
                            .disabled(paging)
                        }
                        if page.items.isEmpty {
                            Text("暂无本地消息").foregroundStyle(.secondary)
                        }
                        ForEach(page.items) { message in
                            messageRow(message).id(message.id)
                        }
                    }
                    .padding()
                }
                .task(id: revision) {
                    let initial = page.items.isEmpty
                    await refresh()
                    if !Task.isCancelled, initial, let last = page.items.last {
                        scroll.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func messageRow(_ message: Message) -> some View {
        VStack(alignment: message.own ? .trailing : .leading, spacing: 5) {
            HStack {
                Text(message.sender).fontWeight(.medium)
                if message.time > 0 {
                    Text(Date(timeIntervalSince1970: message.time), format: .dateTime.month().day().hour().minute())
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.content.indices, id: \.self) { index in
                    MessagePartView(item: message.content[index], core: core, request: .init(
                        op: .media, id: message.id, profile: profile, conversation: conversation.id,
                        part: message.isMixed ? index : nil))
                }
            }
            .padding(10)
            .background(message.own ? Color.accentColor.opacity(0.13) : Color.secondary.opacity(0.10),
                        in: RoundedRectangle(cornerRadius: 9))
        }
        .frame(maxWidth: .infinity, alignment: message.own ? .trailing : .leading)
    }

    private func refresh() async {
        do {
            var latest: Page<Message> = try await core.request(.init(op: .messages, id: conversation.id))
            // Keep history already loaded when the most recent page overlaps it.
            guard !Task.isCancelled else { return }
            let ids = Set(latest.items.map(\.id))
            if let start = latest.items.first?.id,
               let overlap = page.items.firstIndex(where: { $0.id == start }), overlap > 0 {
                latest = .init(items: page.items.prefix(overlap).filter { !ids.contains($0.id) } + latest.items,
                               more: page.more)
            }
            page = latest
            error = nil
        } catch is CancellationError { }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func loadOlder() async {
        guard !paging, let first = page.items.first else { return }
        paging = true
        defer { paging = false }
        do {
            let older: Page<Message> = try await core.request(.init(op: .messages, id: conversation.id, before: first.id))
            guard !Task.isCancelled, page.items.first?.id == first.id else { return }
            page = older.appending(.init(items: page.items, more: older.more))
            error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

private struct MessagePartView: View {
    let item: MessagePart
    let core: CoreClient
    let request: CoreRequest
    @State private var image: NSImage?
    @State private var loading = false
    @State private var error: String?

    private var isImage: Bool { item.kind == "image" || item.kind == "sticker" }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(item.text).textSelection(.enabled)
            if let name = item.detail?.name, !item.text.contains(name) {
                Text(name).font(.caption).textSelection(.enabled)
            }
            if let description = item.detail?.description, description != item.text {
                Text(description).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let url = item.detail?.url {
                Text(url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let image {
                Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 360, maxHeight: 240)
            }
            if item.localMedia == true {
                HStack {
                    if isImage && image == nil {
                        Button("预览图片") { Task { await load(preview: true) } }.disabled(loading)
                    }
                    Button("保存本地文件") { Task { await load(preview: false) } }.disabled(loading)
                }
            } else if item.localMedia == false {
                Text("本地缓存不可用").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
    }

    @MainActor
    private func load(preview: Bool) async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let media: LocalMedia = try await core.request(request)
            if preview {
                guard let decoded = NSImage(data: try await media.read()) else { throw CoreError("media_unavailable") }
                image = decoded
            } else {
                let panel = NSSavePanel()
                let cacheName = URL(fileURLWithPath: media.path).lastPathComponent
                panel.nameFieldStringValue = (item.detail?.name as NSString?)?.lastPathComponent ?? cacheName
                guard await panel.begin() == .OK, let destination = panel.url else { return }
                // Don't replace or follow links to existing files, including the original cache.
                try await media.read().write(to: destination, options: .withoutOverwriting)
            }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
