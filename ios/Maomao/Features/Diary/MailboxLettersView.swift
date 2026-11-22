import SwiftUI

struct MailboxLettersView: View {
    @EnvironmentObject private var store: AppStore
    @State private var expanded: Set<String> = []
    @State private var readError: String?

    var body: some View {
        if let work = store.v2Work {
            section(title: "信箱", error: work.mailboxError, loading: work.loadingMailbox, empty: work.letters.isEmpty) {
                Task { await work.refresh() }
            } letters: {
                if let readError {
                    Text(readError).font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                }
                ForEach(work.letters) { letter in
                    letterRow(id: letter.id, date: letter.date, text: letter.text, unread: letter.readAt == nil) {
                        Task {
                            readError = nil
                            do { try await work.read(letter) }
                            catch { readError = "没能记下已读，请再点一次这封信" }
                        }
                    }
                    .disabled(work.reading.contains(letter.id))
                    .task(id: store.notificationLetterID) {
                        guard store.notificationLetterID == letter.id else { return }
                        expanded.insert(letter.id)
                        do { try await work.read(letter) }
                        catch { readError = "没能记下已读，请再点一次这封信" }
                    }
                }
            }
            .id(ObjectIdentifier(work))
            .task(id: ObjectIdentifier(work)) {
                expanded = []
                readError = nil
                await work.refresh()
            }
        } else if store.backend.isRemote {
            section(title: "团子留的信", error: store.inboxError, loading: false, empty: store.mailboxLetters.isEmpty) {
                store.refreshInbox()
            } letters: {
                ForEach(store.mailboxLetters) { letter in
                    letterRow(id: letter.id, date: APITicket.parseDate(letter.createdAt), text: letter.text, unread: letter.readAt == nil) {
                        store.readLetter(letter)
                    }
                    .onAppear {
                        if store.notificationLetterID == letter.id {
                            expanded.insert(letter.id)
                            store.readLetter(letter)
                        }
                    }
                }
            }
        }
    }

    private func section<Letters: View>(title: String, error: String?, loading: Bool, empty: Bool, retry: @escaping () -> Void,
                                       @ViewBuilder letters: () -> Letters) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(text: title)
            if let error {
                Text(error).font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                TextLink(text: "重新读取", size: 13, action: retry)
            } else if empty {
                if loading { ProgressView() }
                else { Text("信箱里还没有新的信").font(Typo.sans(13)).foregroundStyle(Palette.ink3) }
            }
            letters()
        }.padding(.bottom, 16)
    }

    private func letterRow(id: String, date: Date?, text: String, unread: Bool, read: @escaping () -> Void) -> some View {
        Button {
            if expanded.contains(id) { expanded.remove(id) }
            else { expanded.insert(id) }
            // A second tap can retry a failed acknowledgement. Only the server marks the letter read.
            if unread { read() }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(unread ? "一封新信" : "团子留的信").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                    Spacer()
                    if let date {
                        Text(date.formatted(date: .abbreviated, time: .omitted)).font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                    }
                }
                Text(text).font(Typo.serif(16)).lineSpacing(8)
                    .foregroundStyle(Palette.paperInk)
                    .lineLimit(expanded.contains(id) || (store.v2Work == nil && store.notificationLetterID == id) ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(18)
            .background(Palette.paper, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
        }.buttonStyle(.plain)
        .id(id)
    }
}
