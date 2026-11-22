import SwiftUI

extension AppStore {
    func bindV2World() {
        v2World?.close()
        v2World = nil
        guard let chat = v2Chat else { return }
        worldBridge?.stop()
        worldBridge = nil
        v2World = V2WorldBridge(connection: chat.connection, engine: world, changes: chat.changes,
            changed: { [weak self] in self?.objectWillChange.send() },
            announce: { [weak self] in self?.announce($0) })
    }
}
