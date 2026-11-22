import SwiftUI

extension View {
    func catDiarySourceConfirmation(_ selection: Binding<V2.CatDiarySource?>, store: V2CatDiaryStore) -> some View {
        alert("允许团子在自己的日记里引用？", isPresented: Binding(
            get: { selection.wrappedValue != nil },
            set: { if !$0 { selection.wrappedValue = nil } }
        ), presenting: selection.wrappedValue) { source in
            Button("确认授权") { Task { await store.confirm(source) } }
            Button("取消", role: .cancel) {}
        } message: { source in
            Text(source.kind == .diary
                 ? "团子可以选用这条日记的当前版本。你和伴侣都可以读到团子写的日记。"
                 : "团子可以选用这句原话。你和伴侣都可以读到团子写的日记。")
        }
    }
}
