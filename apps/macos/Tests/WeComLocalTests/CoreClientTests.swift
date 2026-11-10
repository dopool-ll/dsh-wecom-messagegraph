import Foundation
import XCTest
@testable import WeComLocal

final class CoreClientTests: XCTestCase {
    func testBundledHelperSpeaksTheNativeClientProtocol() async throws {
        guard let path = ProcessInfo.processInfo.environment["WECOM_TEST_CORE"] else {
            throw XCTSkip("Set WECOM_TEST_CORE to the packaged helper to test process IPC.")
        }
        let core = CoreClient(executable: URL(fileURLWithPath: path))
        async let status: SyncState = core.request(.init(op: .status))
        async let conversations: Page<Conversation> = core.request(.init(op: .conversations, search: "", offset: 0))
        let (initial, page) = try await (status, conversations)
        XCTAssertEqual(initial.phase, .idle)
        XCTAssertNil(initial.profile)
        XCTAssertTrue(page.items.isEmpty)
        XCTAssertFalse(page.more)

        do {
            let _: SyncState = try await core.request(.init(op: .select, id: "missing"))
            XCTFail("Selecting an unknown profile should fail")
        } catch let error as CoreError {
            XCTAssertEqual(error.code, "profile_not_found")
        }
        let afterError: SyncState = try await core.request(.init(op: .status))
        XCTAssertEqual(afterError.revision, initial.revision)
    }
}
