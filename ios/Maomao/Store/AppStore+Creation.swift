import SwiftUI
import CryptoKit

extension CreationDraft.Step {
    var stepNumber: Int { rawValue }
}

extension AppStore {
    var creationStorage: CreationStorage {
        let identity = backend.storageIdentity
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return CreationStorage(url: root.appendingPathComponent("CreationRecords/" + digest + ".json"))
    }

    /// 只迁移原本机空间，不能把全局旧资料猜成某个远端账号的资料。
    func loadCreation() {
        if backend.mode == .service || backend.mode == .paired {
            onboardingTask?.cancel()
            onboarding = nil
            creationArchive = CreationArchive()
            creationLoadFailed = false
            return
        }
        onboardingTask?.cancel()
        restoringCreation = true
        creationArchive = CreationArchive()
        creationLoadFailed = false
        creationSaveFailed = false
        do {
            if let saved = try creationStorage.load() {
                applyCreation(saved)
            } else {
                let ud = UserDefaults.standard
                let hasLegacy = !backend.isRemote && (ud.object(forKey: "maomao.createdAt") != nil || ud.object(forKey: "maomao.temperament") != nil)
                if hasLegacy {
                    let t = ud.string(forKey: "maomao.temperament").flatMap(Temperament.init(rawValue:)) ?? .slow
                    let oldTraits = ud.dictionary(forKey: "maomao.traits") as? [String: Int] ?? [:]
                    let traits = Dictionary(uniqueKeysWithValues: Trait.allCases.map { ($0.rawValue, min(2, max(0, oldTraits[$0.rawValue] ?? 1))) })
                    let profile = CatProfile(id: UUID(), name: SeedData.defaultCatName, appearance: "orange", temperament: t.rawValue,
                                             traits: traits, createdAt: ud.object(forKey: "maomao.createdAt") as? Date ?? Date(), firstReply: nil, meeting: [])
                    let migrated = CreationArchive(profile: profile)
                    try creationStorage.save(migrated)
                    applyCreation(migrated)
                } else if backend.isRemote {
                    // 开发账号已由脚本建猫，保持原有入口；不伪称已拉取服务端档案。
                    applyCreation(CreationArchive())
                } else {
                    let fresh = CreationArchive(draft: CreationDraft())
                    try creationStorage.save(fresh)
                    applyCreation(fresh)
                }
            }
        } catch {
            applyCreation(CreationArchive(draft: CreationDraft()))
            creationLoadFailed = true
        }
        restoringCreation = false
        resumeMeeting()
    }

    private func applyCreation(_ archive: CreationArchive) {
        let wasRestoring = restoringCreation
        restoringCreation = true
        creationArchive = archive
        let draft = archive.draft
        let profile = archive.profile
        onboarding = draft?.step
        pickedAppearance = draft?.appearance ?? profile?.appearance ?? "orange"
        temperament = Temperament(rawValue: draft?.temperament ?? profile?.temperament ?? "slow") ?? .slow
        let traits = draft?.traits ?? profile?.traits ?? [:]
        traitLevels = Dictionary(uniqueKeysWithValues: Trait.allCases.map { ($0, traits[$0.rawValue] ?? 1) })
        traitsOpen = draft?.traitsOpen ?? false
        nameDraft = draft?.name ?? profile?.name ?? ""
        meetDraft = draft?.input ?? ""
        meetLines = draft?.lines ?? profile?.meeting ?? []
        meetDone = draft?.meeting == .done || draft?.meeting == .skipped
        createdAt = profile?.createdAt ?? Date()
        nameError = nil
        screen = .home
        compileBehavior()
        restoringCreation = wasRestoring
    }

    private var currentCreationDraft: CreationDraft? {
        guard var draft = creationArchive.draft else { return nil }
        draft.appearance = pickedAppearance
        draft.temperament = temperament.rawValue
        draft.traits = Dictionary(uniqueKeysWithValues: traitLevels.map { ($0.key.rawValue, $0.value) })
        draft.traitsOpen = traitsOpen
        draft.name = nameDraft
        draft.input = meetDraft
        return draft
    }

    @discardableResult
    private func saveCreation(_ archive: CreationArchive) -> Bool {
        guard !creationLoadFailed else { return false }
        do {
            try creationStorage.save(archive)
            creationArchive = archive
            creationSaveFailed = false
            return true
        } catch {
            creationSaveFailed = true
            return false
        }
    }

    func persistCreationDraft() {
        guard !restoringCreation, !creationLoadFailed, let draft = currentCreationDraft else { return }
        var archive = creationArchive
        archive.draft = draft
        saveCreation(archive)
    }

    func retryCreationSave() {
        persistCreationDraft()
        if !creationSaveFailed { resumeMeeting() }
    }

    @discardableResult
    private func commitDraft(_ draft: CreationDraft) -> Bool {
        var archive = creationArchive
        archive.draft = draft
        guard saveCreation(archive) else { return false }
        applyCreation(archive)
        return true
    }

    func startOnboarding() {
        guard !creationLoadFailed else { return }
        // 保留已完成档案直到本轮确认；调试重走不会提前抹去旧身份。
        guard commitDraft(CreationDraft()) else { flash("创建资料没有保存成功，请重试"); return }
        cancelEverything()
        showsMe = false
        mailboxOpen = false
    }

    func onboardingBack() {
        guard var draft = currentCreationDraft, draft.step != .firstMeeting else { return }
        draft.step = OnboardingStep(rawValue: max(0, draft.step.rawValue - 1)) ?? .welcome
        commitDraft(draft)
    }

    func onboardingNext() {
        guard var draft = currentCreationDraft, draft.step != .firstMeeting else { return }
        if draft.step == .naming {
            guard draft.validName else { nameError = "名字要 1 到 8 个字"; return }
            draft.step = .firstMeeting
            draft.meeting = .greeting
            draft.lines = [CreationLine(text: "你来了。", isCat: true)]
        } else {
            draft.step = OnboardingStep(rawValue: draft.step.rawValue + 1) ?? .naming
        }
        if commitDraft(draft) { resumeMeeting() }
    }

    func rerollNames() { namePoolIndex += 1 }

    func sendMeetReply() {
        guard !creationSaveFailed, var draft = currentCreationDraft, draft.step == .firstMeeting,
              draft.meeting == .greeting || draft.meeting == .question else { return }
        let text = meetDraft.trimmed
        guard !text.isEmpty else { return }
        draft.firstReply = text
        draft.input = ""
        draft.lines.append(CreationLine(text: text, isCat: false))
        draft.meeting = .replyPending
        if commitDraft(draft) { resumeMeeting() }
    }

    func skipMeet() {
        guard var draft = currentCreationDraft, draft.step == .firstMeeting,
              draft.meeting == .greeting || draft.meeting == .question else { return }
        draft.lines.append(CreationLine(text: "那我先不问了。你在就行。", isCat: true))
        draft.meeting = .skipped
        draft.input = ""
        if commitDraft(draft) { onboardingTask?.cancel() }
    }

    private func resumeMeeting() {
        onboardingTask?.cancel()
        guard !creationLoadFailed, let draft = creationArchive.draft, draft.step == .firstMeeting,
              draft.meeting == .greeting || draft.meeting == .replyPending else { return }
        let identity = backend
        onboardingTask = Task { @MainActor [weak self] in
            do { try await Self.sleep(draft.meeting == .greeting ? 1400 : 900) } catch { return }
            guard let self, self.backend == identity, var current = self.currentCreationDraft,
                  current.id == draft.id, current.step == .firstMeeting, current.meeting == draft.meeting else { return }
            current.completeMeeting()
            withAnimation(.easeOut(duration: Metrics.fade)) { _ = self.commitDraft(current) }
        }
    }

    func enterYard() {
        guard !creationSaveFailed, let draft = currentCreationDraft, let profile = draft.profile(createdAt: Date()) else { return }
        // 确认身份与清除草稿同一次落盘。重复点击不会再生成身份或刷新领养日期。
        let archive = CreationArchive(profile: profile)
        guard saveCreation(archive) else { return }
        onboardingTask?.cancel()
        applyCreation(archive)
        greetedThisSession = false
        if backend.isRemote { remoteUpdateCat() }
    }
}
