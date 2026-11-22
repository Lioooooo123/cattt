import HostCore
import SwiftUI

// Published by the supervisor on the main queue. The pairing workspace can observe it too.
final class BunHostWindowState: ObservableObject {
    @Published var hostState: BunHost.State = .starting
}

struct CompanionWindow: View {
    let host: BunHost
    @ObservedObject var state: BunHostWindowState
    var body: some View {
        BunCompanionView(host: host, ready: state.hostState == .ready, status: state.hostState.message)
    }
}
