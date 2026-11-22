import Foundation

extension V2Client {
    func changesRequest(cursor: String?, limit: Int?) throws -> URLRequest {
        guard cursor != "", limit.map({ (1...100).contains($0) }) ?? true else { throw V2.APIError.invalidRequest }
        var query: [URLQueryItem] = []
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        if let limit { query.append(.init(name: "limit", value: String(limit))) }
        var req = try request("GET", "changes", query: query)
        // 保留游标的字面 +，避免服务端把它当成空格。
        if let url = req.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let encoded = parts.percentEncodedQuery, encoded.contains("+") {
            parts.percentEncodedQuery = encoded.replacingOccurrences(of: "+", with: "%2B")
            req.url = parts.url
        }
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 15
        return req
    }

    func changes(cursor: String?, limit: Int? = nil) async throws -> V2.ChangesPage {
        let (data, response) = try await session.data(for: changesRequest(cursor: cursor, limit: limit))
        return try decodeChanges(response, data: data)
    }

    func decodeChanges(_ response: URLResponse, data: Data) throws -> V2.ChangesPage {
        guard let http = response as? HTTPURLResponse, let url = http.url,
              url.scheme == "https", url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port else {
            throw V2.ChangesError.invalidResponse
        }
        if http.statusCode == 409 {
            struct Conflict: Decodable {
                struct Detail: Decodable {
                    let code: String
                    let writerHostID: String?
                    enum CodingKeys: String, CodingKey { case code; case writerHostID = "writer_host_id" }
                }
                let error: Detail
                let reset: Bool?
                let generation: String?
            }
            if let conflict = try? V2.decoder.decode(Conflict.self, from: data) {
                switch conflict.error.code {
                case "cursor_reset_required":
                    guard conflict.reset == true, let generation = conflict.generation, !generation.isEmpty else {
                        throw V2.ChangesError.invalidResponse
                    }
                    throw V2.ChangesError.resetRequired(generation: generation)
                case "wrong_home_host":
                    guard let host = conflict.error.writerHostID, !host.isEmpty else { throw V2.ChangesError.invalidResponse }
                    throw V2.ChangesError.wrongHomeHost(writerHostID: host)
                default: break
                }
            }
        }
        try validate(http, data: data)
        guard http.statusCode == 200 else { throw V2.ChangesError.invalidResponse }
        return try V2.decoder.decode(V2.ChangesPage.self, from: data)
    }
}
