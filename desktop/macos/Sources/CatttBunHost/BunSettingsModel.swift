import Foundation
import HostCore
import Observation

@MainActor @Observable final class BunSettingsModel {
    struct Snapshot {
        let identity: BunPeerIdentity
        let peers: [BunPeer]
        let family: BunMemberState
        let invites: [BunOpenInvite]

        var waitingForFamily: Bool {
            !family.isCreator && (family.members.isEmpty ||
                !peers.contains { $0.id == family.household.originHostID && $0.sync.cursor != nil })
        }
    }

    let client: BunAdminClient
    let directory: URL
    private(set) var hostState: BunHost.State = .starting
    private(set) var snapshot: Snapshot?
    private(set) var loadError: String?
    private(set) var busy = false
    private var revision = 0

    init(client: BunAdminClient, directory: URL) {
        self.client = client
        self.directory = directory
    }

    var ready: Bool { hostState == .ready }

    func updateHostState(_ state: BunHost.State) {
        guard hostState != state else { return }
        hostState = state
        revision += 1
        if !ready {
            snapshot = nil
            loadError = nil
        }
    }

    func poll() async {
        while !Task.isCancelled && ready {
            if !busy { await refresh() }
            do { try await Task.sleep(for: .seconds(3)) }
            catch { return }
        }
    }

    func perform<Value>(_ operation: () async throws -> Value) async throws -> Value {
        guard ready, !busy else { throw BunAdminError.unavailable }
        revision += 1
        busy = true
        defer { busy = false }
        do {
            let value = try await operation()
            await refresh()
            return value
        } catch {
            await refresh()
            throw error
        }
    }

    private func refresh() async {
        guard ready else { return }
        let requestedRevision = revision
        do {
            async let identity = client.identity()
            async let peers = client.peers()
            async let family = client.members()
            async let invites = client.openInvites()
            let value = try await Snapshot(identity: identity, peers: peers, family: family, invites: invites)
            guard !Task.isCancelled, revision == requestedRevision else { return }
            guard value.identity.descriptor.hostID == value.family.hostID,
                  value.identity.descriptor.householdID == value.family.household.id else {
                throw BunAdminError.invalidResponse
            }
            loadError = nil
            snapshot = value
        } catch {
            guard !Task.isCancelled, revision == requestedRevision else { return }
            loadError = error.localizedDescription
        }
    }
}
