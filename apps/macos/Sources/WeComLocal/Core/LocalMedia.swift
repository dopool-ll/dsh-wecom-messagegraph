import Darwin
import Foundation

/// Reads only the cache file whose identity and size the helper already validated.
struct LocalMedia: Decodable, Sendable {
    let path: String
    let size: Int
    let device: String
    let inode: String
    let modified: String

    func read() async throws -> Data {
        try await Task.detached(priority: .userInitiated) { try readCheckedFile() }.value
    }

    private func readCheckedFile() throws -> Data {
        guard size > 0, size <= 64 * 1024 * 1024 else { throw CoreError("media_unavailable") }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw CoreError("media_unavailable") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        func matchesFile() -> Bool {
            var status = stat()
            guard fstat(fd, &status) == 0 else { return false }
            let nanos = Int64(status.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(status.st_mtimespec.tv_nsec)
            return status.st_mode & S_IFMT == S_IFREG && status.st_size == size &&
                String(status.st_dev) == device && String(status.st_ino) == inode && String(nanos) == modified
        }
        guard matchesFile(), let bytes = try file.read(upToCount: size), bytes.count == size, matchesFile() else {
            throw CoreError("media_unavailable")
        }
        return bytes
    }
}
