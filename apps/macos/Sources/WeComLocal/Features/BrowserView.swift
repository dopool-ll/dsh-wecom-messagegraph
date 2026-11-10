import SwiftUI

struct BrowserView: View {
    let core: CoreClient
    let profile: String
    let revision: Int
    let section: ArchiveSection

    @State private var search = ""
    @State private var filter: ArchiveFilter = .all
    @State private var read: ReadFilter = .all
    @State private var conversations = Page<Conversation>.empty
    @State private var contacts = Page<Contact>.empty
    @State private var selectedConversation: String?
    @State private var selectedContact: String?
    @State private var contactConversation: Conversation?
    @State private var paging = false
    @State private var error: String?
    @State private var activeQuery: Query?

    private struct Query: Equatable {
        let section: ArchiveSection
        let revision: Int
        let search: String
        let filter: ArchiveFilter
        let read: ReadFilter
    }

    private var query: Query {
        let conversationList = section == .conversations
        let scope = conversationList || !filter.isConversationOnly ? filter : .all
        return .init(section: section, revision: revision, search: search, filter: scope,
                     read: conversationList ? read : .all)
    }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                VStack {
                    TextField(section == .contacts ? "搜索联系人" : "搜索会话", text: $search)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Picker("类型", selection: $filter) {
                            ForEach(ArchiveFilter.allCases.filter { section == .conversations || !$0.isConversationOnly }) {
                                Text($0.title).tag($0)
                            }
                        }
                        if section == .conversations {
                            Picker("阅读状态", selection: $read) {
                                ForEach(ReadFilter.allCases) { Text($0.title).tag($0) }
                            }
                        }
                    }
                    .labelsHidden()
                }
                .padding(10)
                Divider()
                if section == .conversations { conversationList } else { contactList }
                if let error { Text(error).font(.caption).foregroundStyle(.secondary).padding(8) }
            }
            .frame(minWidth: 250, idealWidth: 300, maxWidth: 390)

            detail
                .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: section) { _ in
            filter = .all
            search = ""
            selectedConversation = nil
            selectedContact = nil
            contactConversation = nil
        }
        .onChange(of: selectedContact) { _ in contactConversation = nil }
        .task(id: query) {
            await load(query, append: false)
        }
    }

    private var conversationList: some View {
        List(selection: $selectedConversation) {
            ForEach(conversations.items) { conversation in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(conversation.name).fontWeight(.medium).lineLimit(1)
                        Spacer()
                        if conversation.muted { Image(systemName: "bell.slash").foregroundStyle(.secondary) }
                        if let unread = conversation.unreadCount, unread > 0 {
                            Text(unread.formatted()).font(.caption).monospacedDigit()
                        }
                    }
                    Text([conversation.previewSender, conversation.preview].compactMap { $0 }.joined(separator: ": "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 3)
                .tag(conversation.id)
            }
            if conversations.more { moreButton }
        }
        .listStyle(.sidebar)
        .overlay { emptyList(when: conversations.items.isEmpty) }
    }

    private var contactList: some View {
        List(selection: $selectedContact) {
            ForEach(contacts.items) { contact in
                VStack(alignment: .leading, spacing: 3) {
                    Text(contact.name).fontWeight(.medium).lineLimit(1)
                    Text([scopeLabel(contact.scope), contact.job].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 3)
                .tag(contact.id)
            }
            if contacts.more { moreButton }
        }
        .listStyle(.sidebar)
        .overlay { emptyList(when: contacts.items.isEmpty) }
    }

    private var moreButton: some View {
        Button(paging ? "正在读取…" : "加载更多") { Task { await load(query, append: true) } }
            .disabled(paging || activeQuery != query)
    }

    @ViewBuilder private func emptyList(when empty: Bool) -> some View {
        if empty && activeQuery == query && error == nil {
            Text("没有匹配的记录").foregroundStyle(.secondary).allowsHitTesting(false)
        }
    }

    @ViewBuilder private var detail: some View {
        if section == .conversations,
           let conversation = conversations.items.first(where: { $0.id == selectedConversation }) {
            chat(conversation)
        } else if section == .contacts,
                  let contact = contacts.items.first(where: { $0.id == selectedContact }) {
            if let conversation = contactConversation {
                VStack(spacing: 0) {
                    Button {
                        contactConversation = nil
                    } label: { Label("返回联系人", systemImage: "chevron.left") }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    chat(conversation)
                }
            } else {
                ContactDetail(core: core, contact: contact, revision: revision) { contactConversation = $0 }
                    .id(contact.id)
            }
        } else {
            Label(section == .contacts ? "选择联系人" : "选择会话",
                  systemImage: section == .contacts ? "person.crop.circle" : "bubble.left")
                .foregroundStyle(.secondary)
        }
    }

    private func chat(_ conversation: Conversation) -> some View {
        ChatView(core: core, profile: profile, conversation: conversation, revision: revision)
            .id(conversation.id)
    }

    private func load(_ query: Query, append: Bool) async {
        guard !append || (!paging && activeQuery == query) else { return }
        if append { paging = true }
        defer { if append { paging = false } }
        do {
            if !append && !query.search.isEmpty { try await Task.sleep(for: .milliseconds(180)) }
            switch query.section {
            case .conversations:
                let page: Page<Conversation> = try await core.request(.init(
                    op: .conversations, search: query.search, offset: append ? conversations.items.count : 0,
                    filter: query.filter.rawValue, read: query.read.rawValue))
                guard !Task.isCancelled, query == self.query else { return }
                conversations = append ? conversations.appending(page) : page
            case .contacts:
                let page: Page<Contact> = try await core.request(.init(
                    op: .contacts, search: query.search, offset: append ? contacts.items.count : 0,
                    filter: query.filter.rawValue))
                guard !Task.isCancelled, query == self.query else { return }
                contacts = append ? contacts.appending(page) : page
            case .sync: return
            }
            activeQuery = query
            error = nil
        } catch is CancellationError { }
        catch { if !Task.isCancelled && query == self.query { self.error = error.localizedDescription } }
    }
}

private struct ContactDetail: View {
    let core: CoreClient
    let contact: Contact
    let revision: Int
    let open: (Conversation) -> Void
    @State private var conversations = Page<Conversation>.empty
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading) {
            Label(contact.name, systemImage: "person.crop.circle").font(.title2.bold())
            Text([scopeLabel(contact.scope), contact.job].filter { !$0.isEmpty }.joined(separator: " · "))
                .foregroundStyle(.secondary)
            Divider()
            Text("发过消息的会话").font(.headline)
            List(conversations.items) { conversation in
                Button { open(conversation) } label: { Label(conversation.name, systemImage: "bubble.left") }
                    .buttonStyle(.plain)
            }
            if let error { Text(error).foregroundStyle(.secondary) }
        }
        .padding()
        .task(id: revision) {
            do {
                let page: Page<Conversation> = try await core.request(.init(op: .contactConversations, id: contact.id))
                guard !Task.isCancelled else { return }
                conversations = page
                error = nil
            } catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

private enum ArchiveFilter: String, CaseIterable, Identifiable {
    case all, group, direct, `internal`, external
    var id: Self { self }
    var isConversationOnly: Bool { self == .group || self == .direct }

    var title: String {
        switch self {
        case .all: return "全部类型"
        case .group: return "群聊"
        case .direct: return "单聊"
        case .internal: return "内部"
        case .external: return "外部"
        }
    }
}

private enum ReadFilter: String, CaseIterable, Identifiable {
    case all, read, unread
    var id: Self { self }

    var title: String {
        switch self {
        case .all: return "全部状态"
        case .read: return "已读"
        case .unread: return "未读"
        }
    }
}

func scopeLabel(_ scope: String) -> String {
    switch scope {
    case "internal": return "内部"
    case "external": return "外部"
    default: return "未分类"
    }
}
