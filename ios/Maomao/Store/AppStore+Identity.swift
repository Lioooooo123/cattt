import SwiftUI

extension AppStore {
    func applyServerProfile(_ profile: APICatProfile) {
        guard backend.mode == .paired, let id = UUID(uuidString: profile.id), let created = APITicket.parseDate(profile.createdAt) else { return }
        restoringCreation = true
        creationArchive = CreationArchive(profile: CatProfile(id: id, name: profile.name, appearance: profile.appearance,
            temperament: profile.temperament, traits: profile.traits, createdAt: created, meeting: []))
        pickedAppearance = profile.appearance; temperament = Temperament(rawValue: profile.temperament) ?? .slow
        traitLevels = Dictionary(uniqueKeysWithValues: Trait.allCases.map { ($0, profile.traits[$0.rawValue] ?? 1) })
        nameDraft = profile.name; createdAt = created; onboarding = nil
        restoringCreation = false; compileBehavior()
    }
}
