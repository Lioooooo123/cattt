import Foundation

extension V2Client {
    private struct RegisterWorld: Encodable { let protocol_version = 2 }
    private struct ReportWorld: Encodable {
        let session_id: String
        let generation: String
        let base_revision: String
        let snapshot: V2.WorldObservation
    }
    private struct RequestWorldAction: Encodable {
        let session_id: String
        let generation: String
        let request_id: String
        let destination_id: String
        let state_version: Int
        let activity: String?
    }
    private struct AckWorldAction: Encodable {
        let session_id: String
        let generation: String
        let status: V2.WorldAction.Status
        let snapshot: V2.WorldObservation
        let reason: String?
        let occurred_at: String
    }

    private func worldRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var req = try request(method, "world/" + path, query: query)
        req.timeoutInterval = 4
        return req
    }
    private func worldRequest<Body: Encodable>(_ method: String, _ path: String, body: Body) throws -> URLRequest {
        var req = try worldRequest(method, path)
        req.httpBody = try JSONEncoder().encode(body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }
    func registerSharedWorld() async throws -> V2.WorldRegistration {
        try await json(V2.WorldRegistration.self, worldRequest("POST", "sessions", body: RegisterWorld()))
    }
    func sharedWorld() async throws -> V2.WorldView {
        try await json(V2.WorldView.self, worldRequest("GET", "state"))
    }
    func reportSharedWorld(_ snapshot: WorldSnapshot, revision: String, identity: V2.WorldIdentity) async throws -> V2.WorldView {
        try await json(V2.WorldView.self, worldRequest("PUT", "state", body: ReportWorld(session_id: identity.sessionId,
            generation: identity.generation, base_revision: revision, snapshot: .init(snapshot))))
    }
    func requestSharedWorldAction(_ requestID: UUID, destination: String, activity: String?, stateVersion: Int,
                                  identity: V2.WorldIdentity) async throws -> V2.WorldAction {
        try await json(V2.WorldAction.self, worldRequest("POST", "actions", body: RequestWorldAction(session_id: identity.sessionId,
            generation: identity.generation, request_id: requestID.uuidString.lowercased(), destination_id: destination,
            state_version: stateVersion, activity: activity)))
    }
    func acknowledgeSharedWorld(_ acknowledgement: WorldAcknowledgement) async throws -> V2.WorldAction {
        let command = acknowledgement.command
        guard let status = V2.WorldAction.Status(rawValue: acknowledgement.status) else { throw V2.APIError.invalidRequest }
        return try await json(V2.WorldAction.self, worldRequest("POST", "actions/\(command.id)/ack", body: AckWorldAction(
            session_id: command.sessionId, generation: command.generation, status: status, snapshot: .init(acknowledgement.snapshot),
            reason: acknowledgement.reason, occurred_at: acknowledgement.occurredAt)))
    }
    func sharedWorldEvents(_ identity: V2.WorldIdentity, receive: @escaping (V2SSE.Event) async throws -> Bool) async throws {
        var req = try worldRequest("GET", "events", query: [
            .init(name: "session_id", value: identity.sessionId), .init(name: "generation", value: identity.generation),
        ])
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        try await stream(req, receive: receive)
    }
}
