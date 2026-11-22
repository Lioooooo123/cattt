import Foundation

struct V2FamilyJoin {
    let invitation: PairInvitation
    private let identity: V2.PairResult
    private let client: V2Client

    static func name(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...100).contains(trimmed.utf16.count) ? trimmed : nil
    }

    static func redeem(
        _ invitation: PairInvitation,
        displayName: String,
        deviceName: String,
        select: (PairInvitation) async throws -> V2Client = V2FamilyJoin.selectHost
    ) async throws -> Self {
        guard invitation.kind == .family, invitation.version == 2 else { throw PairingError.invalidLink }
        guard let displayName = name(displayName) else { throw V2.APIError.invalidRequest }
        let selected = try await select(invitation)
        guard selected.baseURL.scheme == "https", selected.baseURL.port == invitation.port,
              invitation.hosts.contains(where: { $0.lowercased() == selected.baseURL.host?.lowercased() }) else {
            throw PairingError.invalidLink
        }
        let anonymous = V2Client(baseURL: selected.baseURL, token: "", session: selected.session)
        var request = try anonymous.request("POST", "invites/accept", body: [
            "code": invitation.code, "display_name": displayName, "device_name": name(deviceName) ?? "iPhone",
        ])
        request.httpShouldHandleCookies = false
        let identity = try await anonymous.json(V2.PairResult.self, request)
        guard V2SyncScope(identity: identity) != nil,
              identity.deviceToken.range(of: #"^mm_dvc_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
            throw V2.ChangesError.identityMismatch
        }
        let client = V2Client(baseURL: selected.baseURL, token: identity.deviceToken, session: selected.session)
        return Self(invitation: invitation, identity: identity, client: client)
    }

    // 只在接受邀请的 HTTPS 地址确认新凭证。回包已拿到时，可重试确认和保存，无需再兑换一次性邀请。
    @MainActor func confirmAndSave(_ save: (V2Connection) throws -> Void) async throws -> V2Connection {
        guard let scope = V2SyncScope(identity: identity) else { throw V2.ChangesError.identityMismatch }
        let me = try await client.me()
        try scope.validate(me, deviceID: identity.deviceId)
        try Task.checkCancellation()
        let confirmed = V2.PairResult(deviceId: identity.deviceId, deviceToken: identity.deviceToken,
                                      member: me.member, household: me.household)
        let connection = V2Connection(hosts: invitation.hosts, port: invitation.port,
                                      fingerprint: invitation.fingerprint, identity: confirmed)
        try save(connection)
        return connection
    }

    private static func selectHost(_ invitation: PairInvitation) async throws -> V2Client {
        try await V2Connection.select(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint)
    }

    static func errorMessage(_ error: Error) -> String {
        if let pairingError = error as? PairingError, case .unavailable = pairingError {
            return "无法连接邀请里的电脑。请核对指纹，并确认手机和电脑在同一个局域网。"
        }
        switch (error as? V2.APIError)?.code {
        case "invite_code_invalid", "http_401": return "邀请已过期、用过或撤销，请在电脑上重新发一份"
        case "member_limit": return "这个家庭的成员名额已满，请在电脑上查看"
        case "peer_sync_pending": return "这台电脑还在同步家庭，请稍后再试"
        case "not_found", "http_404": return "这台电脑暂不支持家庭邀请，请更新电脑端"
        case "invalid_request", "http_400": return "请检查显示名称和邀请链接"
        case "unauthorized": return "未能确认新成员的连接凭证，请在电脑上查看成员与设备"
        default: return error.localizedDescription
        }
    }
}
