import SwiftUI
import AuthenticationServices
import CryptoKit

extension AppStore {
    func prepareAppleLogin() {
        guard !identityBusy else { return }
        let url = BackendConfig.serviceURL ?? (backend.mode == .local ? backend.baseURL : nil)
        guard let url else { identityError = "还没有连接服务器"; return }
        identityBusy = true; identityError = nil
        let client = APIClient(config: BackendConfig(mode: .service, baseURL: url, token: ""))
        Task { @MainActor in
            do { appleLoginNonce = try await client.loginNonce(); appleLoginURL = url }
            catch { identityError = "暂时没能开始登录，请稍后再试" }
            identityBusy = false
        }
    }
    func finishAppleLogin(_ result: Result<ASAuthorization, Error>) {
        guard let nonce = appleLoginNonce, let url = appleLoginURL else { return }
        appleLoginNonce = nil
        guard case let .success(authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken, let token = String(data: data, encoding: .utf8) else {
            identityError = "这次没有完成登录"; return
        }
        identityBusy = true
        Task { @MainActor in
            defer { identityBusy = false }
            do {
                let identity = try await APIClient(config: BackendConfig(mode: .service, baseURL: url, token: "")).appleLogin(identityToken: token, nonce: nonce)
                guard let expires = APITicket.parseDate(identity.expiresAt) else { throw APIError.badResponse }
                let session = AccountSession(accountID: identity.accountId, token: identity.token, appleUserID: credential.user, expiresAt: expires)
                try SessionVault.save(session, origin: url.absoluteString)
                cancelEverything()
                backend = BackendConfig(mode: .service, baseURL: url, token: session.token, accountID: session.accountID)
                messages = []; applyServerProfile(identity.cat); connectBackend(); syncDiary()
            } catch { identityError = "登录未完成，请重试" }
        }
    }
    func applyServerProfile(_ profile: APICatProfile) {
        guard backend.mode == .service || backend.mode == .paired, let id = UUID(uuidString: profile.id), let created = APITicket.parseDate(profile.createdAt) else { return }
        restoringCreation = true
        creationArchive = CreationArchive(profile: CatProfile(id: id, name: profile.name, appearance: profile.appearance,
            temperament: profile.temperament, traits: profile.traits, createdAt: created, meeting: []))
        pickedAppearance = profile.appearance; temperament = Temperament(rawValue: profile.temperament) ?? .slow
        traitLevels = Dictionary(uniqueKeysWithValues: Trait.allCases.map { ($0, profile.traits[$0.rawValue] ?? 1) })
        nameDraft = profile.name; createdAt = created; onboarding = nil
        restoringCreation = false; compileBehavior()
    }
    func signOut() {
        allowProactive = false; proactiveBusy = false; proactiveError = nil
        let client = api
        let device = registeredNotificationDeviceID
        Task { @MainActor in
            if let device { struct OK: Decodable {}; _ = try? await client.json(OK.self, client.request("DELETE", "v1/devices/" + device)) }
            try? await client.logout()
        }
        try? SessionVault.save(nil, origin: backend.baseURL.absoluteString)
        cancelEverything(); worldBridge?.stop(); worldBridge = nil
        registeredNotificationDeviceID = nil
        backend = BackendConfig(mode: .service, baseURL: backend.baseURL, token: "")
        messages = []; mailboxLetters = []; backendStatus = "登录后再一起聊"
    }
    func checkAppleCredential() {
        guard backend.mode == .service, let session = SessionVault.load(origin: backend.baseURL.absoluteString) else { return }
        if session.expiresAt <= Date() { signOut(); return }
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: session.appleUserID) { [weak self] state, _ in
            if state == .revoked || state == .notFound { Task { @MainActor in self?.signOut() } }
        }
    }
    var appleNonceDigest: String { appleLoginNonce.map { SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined() } ?? "" }
}
