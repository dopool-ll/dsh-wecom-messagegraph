import Darwin
import Foundation

/// The serial queue owns the worker and keeps pipe I/O off the UI thread.
final class CoreClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.fde.wecomlocal.core")
    private let executable: URL?
    private var worker: Worker?

    init(executable: URL? = Bundle.main.url(forAuxiliaryExecutable: "wecom-core")) {
        self.executable = executable
    }

    func request<Value: Decodable & Sendable>(_ request: CoreRequest) async throws -> Value {
        try Task.checkCancellation()
        let value: Value = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try self.send(request, as: Value.self) })
            }
        }
        try Task.checkCancellation()
        return value
    }

    private func send<Value: Decodable>(_ request: CoreRequest, as type: Value.Type) throws -> Value {
        guard let executable else { throw CoreError("backend_unavailable") }
        let session: Worker
        do {
            session = try worker ?? Worker(executable)
            worker = session
            return try session.send(request, as: type)
        } catch {
            if !(error is OperationError) { worker = nil }
            if let operation = error as? OperationError { throw CoreError(operation.code) }
            if let coreError = error as? CoreError { throw coreError }
            throw CoreError("backend_unavailable")
        }
    }
}

private struct OperationError: Error { let code: String }

private final class Worker {
    private struct Envelope: Encodable {
        let id: Int
        let request: CoreRequest
    }

    private struct Response<Value: Decodable>: Decodable {
        let id: Int
        let data: Value?
        let error: String?
    }

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var nextID = 0
    private let decoder = JSONDecoder()

    init(_ executable: URL) throws {
        process.executableURL = executable
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid timestamp")
            }
            return date
        }
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw CoreError("backend_unavailable")
        }
        try process.run()
    }

    deinit {
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        try? output.fileHandleForReading.close()
    }

    func send<Value: Decodable>(_ request: CoreRequest, as type: Value.Type) throws -> Value {
        nextID += 1
        var body = try JSONEncoder().encode(Envelope(id: nextID, request: request))
        body.append(0x0a)
        try input.fileHandleForWriting.write(contentsOf: body)

        let line = try readLine()
        guard let response = try? decoder.decode(Response<Value>.self, from: line),
              response.id == nextID else { throw CoreError("backend_protocol_error") }
        if let error = response.error { throw OperationError(code: error) }
        guard let data = response.data else { throw CoreError("backend_protocol_error") }
        return data
    }

    private func readLine() throws -> Data {
        let fd = output.fileHandleForReading.fileDescriptor
        let deadline = DispatchTime.now().uptimeNanoseconds + 60_000_000_000
        var line = Data()
        var chunk = [UInt8](repeating: 0, count: 32_768)
        while line.count < 32 * 1024 * 1024 {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw CoreError("backend_unavailable") }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, Int32((deadline - now + 999_999) / 1_000_000))
            if ready == -1 && errno == EINTR { continue }
            guard ready > 0 else { throw CoreError("backend_unavailable") }
            let count = read(fd, &chunk, chunk.count)
            if count == -1 && errno == EINTR { continue }
            guard count > 0 else { throw CoreError("backend_unavailable") }
            if let newline = chunk[..<count].firstIndex(of: 0x0a) {
                // The worker emits exactly one line for each request and never pushes events.
                guard newline == count - 1 else { throw CoreError("backend_protocol_error") }
                line.append(contentsOf: chunk[..<newline])
                return line
            }
            line.append(contentsOf: chunk[..<count])
        }
        throw CoreError("backend_protocol_error")
    }
}
