import CryptoKit
import Foundation

actor V2AttachmentOutbox {
    struct Scope: Equatable {
        let householdID: String
        let memberID: String
        let deviceID: String
        let conversationID: String

        var directoryName: String {
            let key = [householdID, memberID, deviceID, conversationID].joined(separator: "\u{0}")
            return V2AttachmentBytes.hex(SHA256.hash(data: Data(key.utf8)))
        }
    }

    struct Entry: Codable, Equatable, Identifiable {
        let id: String
        let fileName: String
        let mediaType: String
        let byteSize: Int
        let sha256: String
        var uploadID: String?
        var offset: Int = 0
    }

    private let scope: Scope
    private let directory: URL
    private var active = Set<String>()

    init(root: URL, scope: Scope) {
        self.scope = scope
        directory = root.appending(path: "V2Attachments").appending(path: scope.directoryName)
    }

    func entries() throws -> [Entry] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)
            .map { try read($0.lastPathComponent) }
            .sorted { $0.fileName.localizedStandardCompare($1.fileName) == .orderedAscending }
    }

    func stage(_ source: URL, mediaType: String) throws -> Entry {
        let id = UUID().uuidString.lowercased()
        let name = source.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard V2AttachmentBytes.validName(name) else { throw V2AttachmentError.invalidFile }
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var backupExcluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try backupExcluded.setResourceValues(values)
        let staging = directory.appending(path: ".incoming-" + id)
        try manager.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: staging) }

        let payload = staging.appending(path: "payload")
        guard manager.createFile(atPath: payload.path, contents: nil) else { throw V2AttachmentError.invalidFile }
        let output = try FileHandle(forWritingTo: payload)
        defer { try? output.close() }

        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var copy: Result<(size: Int, sha256: String), Error>?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { url in
            copy = Result {
                guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
                    throw V2AttachmentError.invalidFile
                }
                return try V2AttachmentBytes.digest(url, copyTo: output)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let copy else { throw V2AttachmentError.invalidFile }
        let digest = try copy.get()
        try output.close()

        let entry = Entry(id: id, fileName: name, mediaType: mediaType, byteSize: digest.size, sha256: digest.sha256)
        try write(entry, at: staging)
        try manager.moveItem(at: staging, to: entryDirectory(id))
        return entry
    }

    func upload(_ id: String, client: V2Client, onProgress: (Entry) async -> Void = { _ in }) async throws -> V2.Attachment {
        guard active.insert(id).inserted else { throw V2AttachmentError.server("upload_busy") }
        defer { active.remove(id) }
        var entry = try read(id)
        let directory = entryDirectory(id)
        let initial: V2.UploadStatus
        if let uploadID = entry.uploadID {
            initial = try await client.uploadStatus(uploadID)
        } else {
            initial = try await client.beginUpload(entry, conversationID: scope.conversationID)
        }
        try record(initial, entry: &entry, directory: directory)
        await onProgress(entry)

        let uploadID = initial.id
        var checksumRetried = false
        var incompleteRetried = false
        while true {
            try Task.checkCancellation()
            if entry.offset < entry.byteSize {
                let url = directory.appending(path: "payload")
                guard FileManager.default.fileExists(atPath: url.path) else { throw V2AttachmentError.stagingMissing }
                let payload = try FileHandle(forReadingFrom: url)
                defer { try? payload.close() }
                while entry.offset < entry.byteSize {
                    try Task.checkCancellation()
                    let offset = entry.offset
                    let size = min(V2AttachmentBytes.chunkSize, entry.byteSize - offset)
                    try payload.seek(toOffset: UInt64(offset))
                    guard let chunk = try payload.read(upToCount: size), chunk.count == size else {
                        throw V2AttachmentError.stagingMissing
                    }
                    let status = try await append(client, uploadID: uploadID, offset: offset, chunk: chunk)
                    try record(status, entry: &entry, directory: directory)
                    await onProgress(entry)
                }
            }
            do {
                let file = try await client.completeUpload(uploadID)
                guard file.conversationID == scope.conversationID, file.ownerMemberID == scope.memberID,
                      file.sha256 == entry.sha256, file.byteSize == entry.byteSize, file.fileName == entry.fileName,
                      file.mediaType == entry.mediaType, file.sourceMessageID == nil,
                      file.sourceMessageRev == nil, initial.fileID == nil || initial.fileID == file.id else {
                    throw V2AttachmentError.invalidResponse
                }
                try FileManager.default.removeItem(at: directory)
                return file
            } catch V2AttachmentError.server("checksum_mismatch") where !checksumRetried {
                checksumRetried = true
                let status = try await client.uploadStatus(uploadID)
                try record(status, entry: &entry, directory: directory)
                guard entry.offset == 0 else { throw V2AttachmentError.invalidResponse }
                await onProgress(entry)
            } catch V2AttachmentError.server("upload_incomplete") where !incompleteRetried {
                incompleteRetried = true
                let status = try await client.uploadStatus(uploadID)
                try record(status, entry: &entry, directory: directory)
                await onProgress(entry)
            }
        }
    }

    private func append(_ client: V2Client, uploadID: String, offset: Int, chunk: Data) async throws -> V2.UploadStatus {
        do {
            let status = try await client.appendUpload(uploadID, offset: offset, chunk: chunk)
            guard status.offset == offset + chunk.count else { throw V2AttachmentError.invalidResponse }
            return status
        } catch {
            try Task.checkCancellation()
            switch error {
            case V2AttachmentError.server("offset_mismatch"), V2AttachmentError.server("upload_busy"),
                 V2AttachmentError.server("incomplete_body"), is URLError:
                let status = try await client.uploadStatus(uploadID)
                guard status.offset != offset || status.fileID != nil else { throw error }
                return status
            default: throw error
            }
        }
    }

    private func record(_ status: V2.UploadStatus, entry: inout Entry, directory: URL) throws {
        guard !status.id.isEmpty, entry.uploadID == nil || entry.uploadID == status.id,
              status.byteSize == entry.byteSize, (0...entry.byteSize).contains(status.offset),
              status.fileID == nil || status.offset == entry.byteSize else {
            throw V2AttachmentError.invalidResponse
        }
        entry.uploadID = status.id
        entry.offset = status.offset
        try write(entry, at: directory)
    }

    private func entryDirectory(_ id: String) -> URL { directory.appending(path: id) }

    private func read(_ id: String) throws -> Entry {
        guard UUID(uuidString: id) != nil else { throw V2AttachmentError.stagingMissing }
        let data = try Data(contentsOf: entryDirectory(id).appending(path: "upload.json"))
        let entry = try V2.decoder.decode(Entry.self, from: data)
        guard entry.id == id, (1...V2AttachmentBytes.maxSize).contains(entry.byteSize) else {
            throw V2AttachmentError.stagingMissing
        }
        return entry
    }

    private func write(_ entry: Entry, at directory: URL) throws {
        try V2.encoder.encode(entry).write(to: directory.appending(path: "upload.json"), options: .atomic)
    }
}
