import SwiftUI

/// 左侧地点轨 —— 坐标轴形式：一条竖线把六个地点串起来。
///
/// 线走在图标底下、只在圆之间的空隙里露出来，读起来是「同一条路上的六个点」，
/// 而不是六个各自漂着的按钮。当前查看地点高亮 + 光圈；**猫所在地点右侧带红点**。
/// 六个圆是一组玻璃（iOS 26 放进同一个容器，折射连贯）；选中的那颗上珊瑚色。
struct LocationRail: View {
    @EnvironmentObject private var store: AppStore

    private let dotSize: CGFloat = 34
    private let gap: CGFloat = 14

    var body: some View {
        GlassGroup(spacing: gap) {
            VStack(spacing: gap) {
                ForEach(Array(Location.all.enumerated()), id: \.element.id) { index, location in
                    button(for: location, at: index)
                }
            }
            .background { axis }
        }
        .yardControl("rail")
        .padding(.leading, 12)
        .padding(.top, 196)
        .animation(.easeOut(duration: Metrics.fadeFast), value: store.viewedIndex)
        .animation(.easeOut(duration: Metrics.fadeFast), value: store.catIndex)
    }

    /// 竖线只画在首尾图标的圆心之间，两端不出头。
    private var axis: some View {
        Capsule()
            .fill(Palette.onSceneAxis)
            .frame(width: 1.5)
            .padding(.vertical, dotSize / 2)
    }

    private func button(for location: Location, at index: Int) -> some View {
        let selected = store.viewedIndex == index
        let hasCat = store.catIndex == index

        return Button {
            store.look(at: index)
        } label: {
            ZStack(alignment: .topTrailing) {
                Icons.location(location, color: selected ? Palette.accentInk : Palette.railIcon)
                    .frame(width: dotSize, height: dotSize)
                    .liquidGlass(
                        in: Circle(),
                        tint: selected ? Palette.accent : nil,
                        interactive: true,
                        fallback: selected ? Palette.accent : Palette.onSceneRailOn
                    )

                if hasCat {
                    Circle()
                        .fill(Palette.accent)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().strokeBorder(Palette.onSceneRailOn, lineWidth: 1.5))
                        .offset(x: 4, y: -2)
                }
            }
            .frame(width: dotSize, height: dotSize)
            .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hasCat ? "\(location.name)，团子在这里" : location.name)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .contextMenu {
            if let bridge = store.v2World, bridge.canSubmit {
                Button("请团子来这里") { bridge.request(destination: YardIntent.places[index], activity: nil) }
                if bridge.companionSeat == YardIntent.places[index] {
                    Button("陪我坐一会儿") { bridge.request(destination: YardIntent.places[index], activity: "sit") }
                }
            }
        }
    }
}
