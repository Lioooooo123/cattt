import CryptoKit
import Foundation

extension V2 {
    struct Attachment: Codable, Identifiable {
        let id: String
        let ownerMemberID: String
        let conversationID: String
        let sourceMessageID: String?
        let sourceMessageRev: Int?
        let sha256: String
        let byteSize: Int
        let fileName: String
        let mediaType: String
        let description: String?
        let rev: Int
        let createdAt: Int64
        let updatedAt: Int64
        let available: Bool

        enum CodingKeys: String, CodingKey {
            case id, sha256, description, rev, available
            case ownerMemberID = "owner_member_id", conversationID = "conversation_id"
            case sourceMessageID = "source_message_id", sourceMessageRev = "source_message_rev"
            case byteSize = "byte_size", fileName = "file_name", mediaType = "media_type"
            case createdAt = "created_at", updatedAt = "updated_at"
        }

        var supportsThumbnail: Bool { ["image/png", "image/jpeg", "image/heic", "image/heif"].contains(mediaType) }
        var supportsDescription: Bool { ["image/png", "image/jpeg", "image/webp"].contains(mediaType) }
    }

    struct AttachmentResult: Decodable { let file: Attachment }

    struct AttachmentPage: Decodable {
        let files: [Attachment]
        let nextAfter: String?
        enum CodingKeys: String, CodingKey { case files; case nextAfter = "next_after" }
    }

    struct UploadStatus: Decodable {
        let id: String
        let offset: Int
        let byteSize: Int
        let fileID: String?
        enum CodingKeys: String, CodingKey { case id, offset; case byteSize = "byte_size"; case fileID = "file_id" }
    }

    struct FileDescription: Decodable {
        enum Status: String, Decodable {
            case ready
            case notGenerated = "not_generated"
            case blobUnavailable = "blob_unavailable"
            case modelUnavailable = "model_unavailable"
        }
        struct Value: Codable {
            let id: String
            let fileID: String
            let fileRev: Int
            let sha256: String
            let sourceMessageID: String?
            let sourceMessageRev: Int?
            let text: String
            let modelID: String
            let createdAt: Int64
            enum CodingKeys: String, CodingKey {
                case id, sha256, text
                case fileID = "file_id", fileRev = "file_rev", modelID = "model_id", createdAt = "created_at"
                case sourceMessageID = "source_message_id", sourceMessageRev = "source_message_rev"
            }
        }

        let status: Status
        let description: Value?
        enum CodingKeys: String, CodingKey { case status, description }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            status = try values.decode(Status.self, forKey: .status)
            description = try values.decodeIfPresent(Value.self, forKey: .description)
            guard (status == .ready) == (description != nil) else {
                throw DecodingError.dataCorruptedError(forKey: .description, in: values, debugDescription: "Invalid description result")
            }
        }
    }
}

enum V2AttachmentError: LocalizedError {
    case invalidFile, emptyFile, tooLarge, stagingMissing, invalidResponse, corruptDownload
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidFile: return "无法读取这个文件，请重新选择"
        case .emptyFile: return "不能发送空文件"
        case .tooLarge: return "单个附件最多 25 MB"
        case .stagingMissing: return "这台手机缺少待上传的原件，请重新选择文件"
        case .invalidResponse: return "电脑返回的附件信息有误，请稍后重试"
        case .corruptDownload: return "原件校验失败，请重新下载"
        case .server(let code):
            switch code {
            case "not_found": return "附件已撤回或你无权查看"
            case "blob_unavailable": return "连接的电脑缺少原件"
            case "not_writer": return "请连接保存这份附件的来源电脑"
            case "file_revision_changed": return "附件已经更新，请重新打开"
            case "thumbnail_unsupported": return "这个格式没有缩略图，可以查看原件"
            case "thumbnail_failed", "thumbnail_unavailable": return "缩略图暂时不可用"
            case "description_unsupported": return "这张图片的格式暂不支持生成描述"
            case "payload_too_large": return V2AttachmentError.tooLarge.errorDescription
            case "upload_busy": return "电脑正在处理这份附件，请稍后重试"
            case "upload_incomplete", "offset_mismatch", "checksum_mismatch": return "上传还未完成，可以继续上传"
            default: return V2.APIError(code: code).localizedDescription
            }
        }
    }

    var sourceUnavailable: Bool {
        switch self {
        case .server("not_found"), .server("unauthorized"), .server("file_revision_changed"): return true
        default: return false
        }
    }
}

extension V2Client {
    func attachmentPage(conversationID: String, after: String? = nil) async throws -> V2.AttachmentPage {
        var query = [URLQueryItem(name: "conversation_id", value: conversationID)]
        if let after { query.append(.init(name: "after", value: after)) }
        let page: V2.AttachmentPage = try await attachmentJSON(request("GET", "files", query: query))
        try validateAttachmentPage(page, conversationID: conversationID, after: after)
        return page
    }

    func attachment(id: String, conversationID: String) async throws -> V2.Attachment {
        let result: V2.AttachmentResult = try await attachmentJSON(request("GET", "files/\(id)"))
        guard result.file.id == id, result.file.conversationID == conversationID else {
            throw V2AttachmentError.invalidResponse
        }
        return result.file
    }

    func beginUpload(_ entry: V2AttachmentOutbox.Entry, conversationID: String) async throws -> V2.UploadStatus {
        try await attachmentJSON(request("POST", "files/uploads", body: [
            "client_upload_id": entry.id, "conversation_id": conversationID,
            "sha256": entry.sha256, "byte_size": entry.byteSize,
            "file_name": entry.fileName, "media_type": entry.mediaType
        ]))
    }

    func uploadStatus(_ id: String) async throws -> V2.UploadStatus {
        try await attachmentJSON(request("GET", "files/uploads/\(id)"))
    }

    func appendUpload(_ id: String, offset: Int, chunk: Data) async throws -> V2.UploadStatus {
        var upload = try request("PATCH", "files/uploads/\(id)")
        upload.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        upload.httpBody = chunk
        return try await attachmentJSON(upload)
    }

    func completeUpload(_ id: String) async throws -> V2.Attachment {
        let result: V2.AttachmentResult = try await attachmentJSON(request("POST", "files/uploads/\(id)/complete"))
        return result.file
    }

    func withdrawAttachment(_ id: String) async throws {
        let (_, response) = try await attachmentData(request("DELETE", "files/\(id)"))
        guard response.statusCode == 204 else { throw V2AttachmentError.invalidResponse }
    }

    func fileDescription(_ file: V2.Attachment, generate: Bool = false) async throws -> V2.FileDescription {
        var req = try request(generate ? "POST" : "GET", "files/\(file.id)/description",
                              body: generate ? ["file_rev": file.rev] : nil)
        if generate { req.timeoutInterval = 75 } // 宿主单次本机推理的上限为 60 秒。
        let result: V2.FileDescription = try await attachmentJSON(req)
        if let value = result.description {
            guard value.fileID == file.id, value.fileRev == file.rev, value.sha256 == file.sha256,
                  value.sourceMessageID == file.sourceMessageID, value.sourceMessageRev == file.sourceMessageRev else {
                throw V2AttachmentError.invalidResponse
            }
        }
        return result
    }

    func thumbnail(_ id: String) async throws -> Data {
        let (data, response) = try await attachmentData(request("GET", "files/\(id)/thumbnail"))
        guard response.statusCode == 200, response.mimeType == "image/jpeg" else { throw V2AttachmentError.invalidResponse }
        return data
    }

    func original(_ file: V2.Attachment) async throws -> URL {
        var req = try request("GET", "files/\(file.id)/content")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (download, response) = try await session.download(for: req)
        let manager = FileManager.default
        defer { try? manager.removeItem(at: download) }
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else {
            let handle = try FileHandle(forReadingFrom: download)
            defer { try? handle.close() }
            try validateAttachmentResponse(http, data: try handle.read(upToCount: 8192) ?? Data())
            throw V2AttachmentError.invalidResponse
        }
        let digest = try V2AttachmentBytes.digest(download)
        guard digest.size == file.byteSize, digest.sha256 == file.sha256 else { throw V2AttachmentError.corruptDownload }
        let directory = manager.temporaryDirectory.appending(path: "V2Attachment-" + UUID().uuidString)
        let name = URL(fileURLWithPath: file.fileName).lastPathComponent
        let safeName = V2AttachmentBytes.validName(file.fileName) && name == file.fileName ? name : "附件"
        try manager.createDirectory(at: directory, withIntermediateDirectories: false)
        let destination = directory.appending(path: safeName)
        do {
            try manager.moveItem(at: download, to: destination)
            return destination
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }

    private func validateAttachmentPage(_ page: V2.AttachmentPage, conversationID: String, after: String?) throws {
        guard page.files.allSatisfy({ $0.conversationID == conversationID }),
              page.nextAfter == nil || (page.nextAfter != after && page.nextAfter == page.files.last?.id) else {
            throw V2AttachmentError.invalidResponse
        }
    }

    private func attachmentJSON<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, _) = try await attachmentData(request)
        return try V2.decoder.decode(T.self, from: data)
    }

    private func attachmentData(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = request
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        try validateAttachmentResponse(http, data: data)
        return (data, http)
    }

    private func validateAttachmentResponse(_ response: HTTPURLResponse, data: Data) throws {
        guard (200...299).contains(response.statusCode) else {
            let envelope = try? V2.decoder.decode(V2.ErrorEnvelope.self, from: data)
            throw V2AttachmentError.server(envelope?.error.code ?? "http_\(response.statusCode)")
        }
    }
}

enum V2AttachmentBytes {
    static let chunkSize = 1_048_576
    static let maxSize = 25 * chunkSize

    static func validName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && name.utf16.count <= 255 &&
        name.rangeOfCharacter(from: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\"))) == nil
    }

    static func hex<D: Digest>(_ digest: D) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    static func digest(_ url: URL, copyTo output: FileHandle? = nil) throws -> (size: Int, sha256: String) {
        let source = try FileHandle(forReadingFrom: url)
        defer { try? source.close() }
        var size = 0
        var hash = SHA256()
        while let block = try source.read(upToCount: chunkSize), !block.isEmpty {
            try Task.checkCancellation()
            size += block.count
            guard size <= maxSize else { throw V2AttachmentError.tooLarge }
            hash.update(data: block)
            try output?.write(contentsOf: block)
        }
        guard size > 0 else { throw V2AttachmentError.emptyFile }
        return (size, hex(hash.finalize()))
    }
}
