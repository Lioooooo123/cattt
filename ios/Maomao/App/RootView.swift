import SwiftUI

/// 2026-09-10 起没有底部 Tab 栏：院子就是 app。聊天是场景上的「聊会儿」，
/// 日记是院子里的信箱（纸从里面抽出来），「我的」是右上角头像钮打开的系统 sheet。
struct RootView: View {
    @StateObject private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // 安全区从 GeometryReader 量：reader 本身留在安全区里（这样 proxy.safeAreaInsets 才是真值），
        // 再让里面的 ZStack 铺满整屏。之前 ignoresSafeArea 挂在 reader 上，量出来永远是 0。
        GeometryReader { proxy in
            ZStack {
                PageBackground().ignoresSafeArea()

                if store.world.uses3D, store.onboarding == nil, !store.yardProbeVisible {
                    YardHomeSurface()
                        .environment(\.screenInsets, proxy.safeAreaInsets)
                        .opacity(store.screen == .home ? 1 : 0.001)
                        .allowsHitTesting(store.screen == .home && !store.mailboxOpen && !store.showsMe)
                }

                if !store.yardProbeVisible {
                    screen.environment(\.screenInsets, proxy.safeAreaInsets)
                }

                // 日记纸：从信箱里抽出来，盖在院子上。
                if store.onboarding == nil && !store.yardProbeVisible {
                    PaperSheet(
                        isOpen: store.mailboxOpen,
                        anchor: store.mailboxAnchor,
                        onDismiss: { store.closeMailbox() }
                    ) {
                        DiaryPaperHeader()
                    } content: {
                        DiaryPaperView()
                    }
                    .environment(\.screenInsets, proxy.safeAreaInsets)

                    // 「记一下」抽屉叠在纸上面。
                    if store.isCapturing {
                        CaptureSheet()
                    }
                }

                // 行内轻提示。同一时刻最多一条。
                if let toast = store.toast {
                    VStack {
                        Spacer(minLength: 0)
                        ToastView(text: toast)
                            .padding(.bottom, 120)
                    }
                    .allowsHitTesting(false)
                    .transition(.opacity)
                }

                #if DEBUG
                DebugChip()
                    .environment(\.screenInsets, proxy.safeAreaInsets)
                #endif
            }
            // 聊天交给系统避让键盘；其它全屏页面保留各自现有的布局口径。
            .ignoresSafeArea(.container, edges: usesSystemKeyboardAvoidance ? [.top, .horizontal] : .all)
            .ignoresSafeArea(.keyboard, edges: usesSystemKeyboardAvoidance ? [] : .bottom)
        }
        .environmentObject(store)
        .overlay(alignment: .topTrailing) {
            if store.onboarding != nil {
                Button("连接电脑") { store.openPairing() }
                    .padding().foregroundStyle(Palette.ink)
            }
        }
        .onOpenURL { store.openPairing($0) }
        .sheet(isPresented: $store.showsPairing) { PairingView().environmentObject(store) }
        .onReceive(NotificationCenter.default.publisher(for: .pairedConnectionFailed)) { notification in
            guard notification.object as? String == store.backend.storageIdentity else { return }
            store.reprobePairedHost()
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            store.reprobePairedHost(foreground: true)
            store.resolveNotificationIntent()
            store.refreshInbox()
            await store.refreshFollowupNotifications()
            while !Task.isCancelled {
                store.syncDiary()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .sheet(isPresented: $store.showsMe) {
            MeView()
                .environmentObject(store)
        }
        .onChange(of: store.yardProbeVisible) { updateWorldVisibility() }
        .onChange(of: scenePhase) { updateWorldVisibility() }
        .onChange(of: store.screen) { updateWorldVisibility() }
        .onChange(of: store.onboarding) { updateWorldVisibility() }
        .onAppear {
            if store.v2Chat != nil { store.onboarding = nil }
            updateWorldVisibility()
            #if DEBUG
            if !store.yardProbeVisible { DebugScript.run(on: store) }
            #endif
        }
        // 全套令牌只有浅色一版，深色模式会把院子的地面色冲掉。
        // 例外是入夜后的聊天页：背景是夜里的院子，状态栏、键盘、长按菜单要跟着暗（见 ChatTone）。
        .preferredColorScheme(store.onboarding == nil && store.screen == .chat && ChatTone.from(store.atmosphere).isDark ? .dark : .light)
    }

    private var usesSystemKeyboardAvoidance: Bool {
        store.onboarding == nil && store.screen == .chat && !store.yardProbeVisible
    }

    private func updateWorldVisibility() {
        store.world.setVisibility(home: store.screen == .home && store.onboarding == nil, foreground: scenePhase == .active, enabled: store.onboarding == nil && !store.yardProbeVisible)
        if store.world.uses3D, store.onboarding == nil, !store.yardProbeVisible {
            store.conditionsClock = 1; store.advanceConditions(0)
            store.world.yard3D?.start(intent: store.world.intent3D.request, slot: store.dayPhase.rawValue, weather: store.weather.rawValue)
        }
        if scenePhase != .active { store.rainSound.set(on: false) }
        // 打开 App（或从后台回来）：按性格决定猫来不来门口。
        if scenePhase == .active && !store.yardProbeVisible { store.greetOnOpen() } else if scenePhase == .background { store.greetedThisSession = false }
    }

    @ViewBuilder
    private var screen: some View {
        if store.onboarding != nil && store.v2Chat == nil {
            OnboardingView()
        } else {
            switch store.screen {
            case .home: CompanionHomeView()
            case .chat:
                if let chat = store.v2Chat { V2ChatEntryView(chat: chat) }
                else { ChatView() }
            }
        }
    }
}

struct ToastView: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typo.sans(13))
            .tracking(track(0.06, 13))
            .foregroundStyle(Palette.toastText)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Palette.toastFill, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
    }
}
