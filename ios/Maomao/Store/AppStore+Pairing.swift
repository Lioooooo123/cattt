import SwiftUI

extension AppStore {
    var hasActivePairing: Bool { v2Chat != nil || backend.mode == .paired }

    func unpairV2Host() async {
        guard !pairingBusy, let chat = v2Chat else { return }
        do {
            try V2Vault.retire(chat.connection)
            try V2Vault.save(nil)
            v2Chat = nil
            flushV2PairingRetirements()
            loadDiary()
            connectBackend()
            screen = .home
        } catch { identityError = error.localizedDescription }
    }

    func openPairing(_ url: URL? = nil) {
        guard !pairingBusy else { return }
        pairingError = nil
        pairInvitation = url.flatMap { PairInvitation.parse($0, versions: [1, 2]) }
        if let pairInvitation, pairInvitation != pendingFamilyJoin?.invitation { pendingFamilyJoin = nil }
        if url != nil && pairInvitation == nil { pairingError = PairingError.invalidLink.localizedDescription }
        showsMe = false
        showsPairing = true
    }

    func joinFamily(_ invitation: PairInvitation, displayName: String, confirmedSwitch: Bool) async {
        guard !pairingBusy, pairInvitation == invitation, invitation.kind == .family,
              !hasActivePairing || confirmedSwitch else { return }
        pairingBusy = true; pairingError = nil
        defer { pairingBusy = false }
        let previous = v2Chat?.connection
        do {
            let pending: V2FamilyJoin
            if let issued = pendingFamilyJoin, issued.invitation == invitation {
                pending = issued
            } else {
                pending = try await V2FamilyJoin.redeem(invitation, displayName: displayName, deviceName: UIDevice.current.name)
                pendingFamilyJoin = pending
            }
            let connection = try await pending.confirmAndSave { connection in
                try saveV2Pairing(connection, replacing: previous)
            }
            activateV2Pairing(connection, screen: .home)
            syncHomeFacts()
        } catch {
            pairingError = V2FamilyJoin.errorMessage(error)
        }
    }

    func pairWithHost(_ invitation: PairInvitation) async {
        guard !pairingBusy, invitation.kind == .device else { return }
        pairingBusy = true; pairingError = nil
        defer { pairingBusy = false }
        do {
            let previous = v2Chat?.connection
            if invitation.version == 2 {
                let client = try await V2Connection.select(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint)
                let result = try await client.pair(code: invitation.code, deviceName: UIDevice.current.name)
                let connection = V2Connection(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint, identity: result)
                try saveV2Pairing(connection, replacing: previous)
                activateV2Pairing(connection, screen: .chat)
                return
            }
            let url = try await PairTransport.select(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint)
            let pending = PairedHost(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint,
                                     deviceID: "", deviceToken: "", accountID: "")
            let client = APIClient(config: BackendConfig(mode: .paired, baseURL: url, token: "", pairedHost: pending))
            struct Result: Decodable { let deviceId: String; let deviceToken: String; let accountId: String; let cat: APICatProfile }
            let result = try await client.json(Result.self, client.request("POST", "pair", body: ["code": invitation.code, "device_name": UIDevice.current.name]))
            let paired = PairedHost(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint,
                                    deviceID: result.deviceId, deviceToken: result.deviceToken, accountID: result.accountId)
            try PairVault.save(paired)
            if let previous {
                try V2Vault.retire(previous)
                try V2Vault.save(nil)
                v2Chat = nil
                flushV2PairingRetirements()
            }
            pairedProbeTask?.cancel(); pairedProbeTask = nil
            cancelEverything()
            backend = BackendConfig(mode: .paired, baseURL: url, token: paired.deviceToken, accountID: paired.accountID, pairedHost: paired)
            messages = []; applyServerProfile(result.cat)
            connectBackend(); syncDiary()
            showsPairing = false; pairInvitation = nil; pendingFamilyJoin = nil
        } catch { pairingError = error.localizedDescription }
    }

    private func saveV2Pairing(_ connection: V2Connection, replacing previous: V2Connection?) throws {
        if let previous { try V2Vault.retire(previous) }
        try V2Vault.save(connection)
    }

    private func activateV2Pairing(_ connection: V2Connection, screen: Screen) {
        pairedProbeTask?.cancel(); pairedProbeTask = nil
        diarySyncTask?.cancel()
        v2Chat = V2ChatStore(connection: connection)
        flushV2PairingRetirements()
        connectBackend()
        onboarding = nil
        self.screen = screen
        showsPairing = false; pairInvitation = nil; pendingFamilyJoin = nil
    }

    func flushV2PairingRetirements() {
        guard !flushingV2Retirements else { return }
        let previous = V2Vault.retirements
        guard !previous.isEmpty else { return }
        flushingV2Retirements = true
        Task {
            defer { flushingV2Retirements = false }
            for connection in previous where connection.identity.deviceId != v2Chat?.connection.identity.deviceId {
                do {
                    let client = try await connection.select()
                    do { try await client.unpair() }
                    catch let error as V2.APIError where error.code == "unauthorized" {}
                    try V2Vault.finishRetiring(connection.identity.deviceId)
                } catch {
                    // 旧宿主暂时不可达。保留此设备凭证用于下次前台撤销。
                }
            }
        }
    }

    func reprobePairedHost(foreground: Bool = false) {
        guard let paired = backend.pairedHost, backend.mode == .paired, pairedProbeTask == nil,
              foreground || Date().timeIntervalSince(lastPairProbe) > 5 else { return }
        lastPairProbe = Date()
        pairedProbeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { pairedProbeTask = nil }
            do {
                let url = try await PairTransport.select(hosts: paired.hosts, port: paired.port, fingerprint: paired.fingerprint)
                guard !Task.isCancelled, backend.storageIdentity == paired.storageIdentity else { return }
                backend.baseURL = url
                connectBackend(); syncDiary()
            } catch {
                guard !Task.isCancelled, backend.storageIdentity == paired.storageIdentity else { return }
                backendStatus = "团子在家里的电脑上"
            }
        }
    }

    func unpairHost() {
        guard !pairingBusy, backend.mode == .paired else { return }
        let client = api
        do { try PairVault.save(nil) } catch { identityError = error.localizedDescription; return }
        Task {
            struct OK: Decodable {}
            var request = client.request("POST", "v1/device/unpair"); request.timeoutInterval = 4
            _ = try? await client.json(OK.self, request)
        }
        pairedProbeTask?.cancel(); pairedProbeTask = nil
        inboxTask?.cancel(); inboxTask = nil; inboxRefreshPending = false
        watchdogTask?.cancel(); remoteTurnID = nil
        isWaiting = false; isStreaming = false
        cancelEverything(); worldBridge?.stop(); worldBridge = nil
        backend = BackendConfig(mode: .mock, baseURL: BackendConfig.localURL, token: "")
        messages = []; mailboxLetters = []; backendStatus = nil
        allowProactive = false
    }
}
