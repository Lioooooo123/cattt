import SwiftUI

extension AppStore {
    func openPairing(_ url: URL? = nil) {
        pairingError = nil
        pairInvitation = url.flatMap(PairInvitation.parse)
        if url != nil && pairInvitation == nil { pairingError = PairingError.invalidLink.localizedDescription }
        showsMe = false
        showsPairing = true
    }

    func pairWithHost(_ invitation: PairInvitation) async {
        guard !pairingBusy else { return }
        pairingBusy = true; pairingError = nil
        defer { pairingBusy = false }
        do {
            let url = try await PairTransport.select(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint)
            let pending = PairedHost(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint,
                                     deviceID: "", deviceToken: "", accountID: "")
            let client = APIClient(config: BackendConfig(mode: .paired, baseURL: url, token: "", pairedHost: pending))
            struct Result: Decodable { let deviceId: String; let deviceToken: String; let accountId: String; let cat: APICatProfile }
            let result = try await client.json(Result.self, client.request("POST", "pair", body: ["code": invitation.code, "device_name": UIDevice.current.name]))
            let paired = PairedHost(hosts: invitation.hosts, port: invitation.port, fingerprint: invitation.fingerprint,
                                    deviceID: result.deviceId, deviceToken: result.deviceToken, accountID: result.accountId)
            try PairVault.save(paired)
            pairedProbeTask?.cancel(); pairedProbeTask = nil
            cancelEverything()
            backend = BackendConfig(mode: .paired, baseURL: url, token: paired.deviceToken, accountID: paired.accountID, pairedHost: paired)
            messages = []; applyServerProfile(result.cat)
            connectBackend(); syncDiary()
            showsPairing = false; pairInvitation = nil
        } catch { pairingError = error.localizedDescription }
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
        guard backend.mode == .paired else { return }
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
        registeredNotificationDeviceID = nil
        backend = BackendConfig(mode: .mock, baseURL: BackendConfig.localURL, token: "")
        messages = []; mailboxLetters = []; backendStatus = nil
        allowProactive = false
    }
}
