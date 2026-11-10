import Foundation

struct CoreRequest: Encodable, Sendable {
    enum Operation: String, Encodable, Sendable {
        case discover, select, status, pause, conversations, contacts
        case contactConversations, messages, media, exportDatabases
    }

    let op: Operation
    var id: String? = nil
    var paused: Bool? = nil
    var search: String? = nil
    var offset: Int? = nil
    var filter: String? = nil
    var read: String? = nil
    var before: String? = nil
    var profile: String? = nil
    var conversation: String? = nil
    var part: Int? = nil
    var directory: String? = nil
}

struct Profile: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let available: Bool
    let issue: String?
}

struct SyncState: Decodable, Sendable {
    enum Phase: String, Decodable, Sendable {
        case idle, syncing, ready, paused, retrying

        var title: String {
            switch self {
            case .idle: return "等待选择"
            case .syncing: return "正在同步"
            case .ready: return "同步正常"
            case .paused: return "同步已暂停"
            case .retrying: return "等待重试"
            }
        }
    }

    struct Counts: Decodable, Sendable {
        let conversations: Int
        let contacts: Int
        let messages: Int
    }

    let phase: Phase
    let profile: String?
    let revision: Int
    let updatedAt: Date?
    let issues: [String]
    let counts: Counts

    static let initial = SyncState(phase: .idle, profile: nil, revision: 0, updatedAt: nil, issues: [],
                                   counts: .init(conversations: 0, contacts: 0, messages: 0))
}

struct Conversation: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let preview: String
    let previewSender: String?
    let count: Int
    let unreadCount: Int?
    let muted: Bool
    let scope: String
}

struct Contact: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let job: String
    let scope: String
}

struct MessagePart: Decodable, Sendable {
    struct Detail: Decodable, Sendable {
        let name: String?
        let description: String?
        let url: String?
    }

    let text: String
    let kind: String
    let detail: Detail?
    let localMedia: Bool?
}

struct Message: Decodable, Identifiable, Sendable {
    let id: String
    let sender: String
    let time: Double
    let own: Bool
    let content: [MessagePart]
    let isMixed: Bool

    private enum CodingKeys: String, CodingKey { case id, sender, time, own, parts }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        sender = try values.decode(String.self, forKey: .sender)
        time = try values.decode(Double.self, forKey: .time)
        own = try values.decode(Bool.self, forKey: .own)
        if let parts = try values.decodeIfPresent([MessagePart].self, forKey: .parts) {
            isMixed = true
            content = parts
        } else {
            isMixed = false
            content = [try MessagePart(from: decoder)]
        }
    }
}

struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let more: Bool

    static var empty: Self { .init(items: [], more: false) }

    func appending(_ page: Self) -> Self {
        .init(items: items + page.items, more: page.more)
    }
}

struct DatabaseExport: Decodable, Sendable {
    let directory: String
    let files: [String]
}

struct CoreError: LocalizedError {
    let code: String

    init(_ code: String) { self.code = code }

    var errorDescription: String? {
        switch code {
        case "backend_unavailable": return "本地数据服务暂时不可用。"
        case "backend_protocol_error": return "无法读取本地数据服务的响应。"
        case "source_access_denied": return "无法访问企业微信数据，请在系统设置授权后重新扫描。"
        case "vid_not_verified": return "没有找到能解开此档案的 VID。"
        case "contacts_missing", "contacts_key_unverified": return "联系人库暂时不可用，仍可浏览消息。"
        case "conversations_missing", "conversations_key_unverified": return "会话库暂时不可用，将按会话编号分组。"
        case "source_changed", "source_busy": return "源文件正在变化，稍后重试。"
        case "unsupported_schema": return "暂不支持当前企业微信数据库结构。"
        case "export_inside_source": return "请选择企业微信数据目录之外的保存位置。"
        case "export_not_ready": return "档案尚无可导出的快照。"
        case "export_failed": return "导出失败，请检查保存位置和可用空间。"
        case "media_unavailable": return "本地媒体缓存暂时不可用。"
        default: return "本次读取未完成，请检查本地档案和同步状态。"
        }
    }
}
