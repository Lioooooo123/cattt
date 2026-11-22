# 猫猫 iOS MVP · SwiftUI 实现

原生 SwiftUI 实现。产品文档位于 `docs/产品/`，决策与方案见 `docs/README.md`；现行界面以本工程为准（`design/` 只留配色令牌）。
早期交接文档中的 `project/Maomao iOS MVP.dc.html` 与 `project/design_handoff_ios_mvp/README.md` 路径不在当前资料包中；构建不依赖它们。
覆盖核心闭环：创建流程（5 屏）、陪伴主页（毛毡小院世界层）、专注聊天、日记（院子信箱里抽出的纸）、我的（右上角头像 sheet）。2026-09-10 起没有底部 Tab 栏。

**2026-09-27 起：世界层以 3D 为准线**（`web/` 的院子与 3D 团子，WKWebView 内嵌，见 [决策](../docs/决策/2026-09-27-3D为准线.md)）。本工程的 2D 世界层（`Model/WorldScene|WorldInteraction|WorldDepth|WorldCamera` 与逐帧素材）**冻结**：只修阻断性 bug，不再加功能、不出新帧、不重渲。正式首页已于10-05默认接入3D；10-13聊天底、头像和原生页面配套已接入，见文末最新记录。

产品要旨没有变：**没有打卡、没有等级金币、没有喂养任务、没有连续天数**。
用户几天不来，猫不掉状态、不催、不怪。任何带「任务」「进度」「坚持」意味的措辞都不要往里加。

## 跑起来

### API v2 聊天（R8 首段）

使用 `host/` 生成的 `maomao://pair?v=2&h=…&p=8789&c=…&fp=…` 链接，在手机核对 CA 指纹后连接。设备凭证单独保存在 Keychain 的 ThisDeviceOnly 项，不覆盖旧配对。v1 配对和本地模拟路径仍保留。

第二位成员与签发邀请的 Mac 连同一局域网，打开 `maomao://invite?v=2&…` 链接，也可在「连接家里的电脑」粘贴链接。已配对时从「我的 → 使用家庭邀请链接」进入。与邀请人核对电脑指纹，填写显示名称，再确认加入。已配对的手机会另外确认切换。手机用新凭证核对 `/v2/me`，保存成功后回到院子并刷新新成员的数据；失败时仍可使用原配对。用过或过期的链接须由 Mac 重新签发。

v2 配对后，「聊会儿」进入两行聊天列表：「我们仨」是家庭群聊，「我和团子」只展示当前成员的单聊。消息标明「我」、伴侣姓名或「团子」。打开聊天时每三秒通过不透明 after 游标补收消息，并重读末页以收取迟到的复制消息。顶部可加载更早记录。

R8.6 支持通过本方电脑代送群聊。发出前，手机按家庭、成员、设备和会话保留正文与同一个请求键。收到 202 后记录相对回执地址，只在配对的宿主查询，并区分等待发布权、等另一台电脑接收和等待同步。如果首次回执丢失，用相同键恢复那次发送。宿主明确拒绝后，点「重新发送」才创建新键。预览会保留到宿主消息可见，历史按真实消息 ID 归并。重新打开聊天会继续查询，切换配对或解除配对会终止旧身份的查询，本机记录仍按原身份隔离。

协议层在 `Maomao/Backend/V2/`，含请求、分页、错误码、轮次 SSE 解析与快照替换。host R3-2 返回轮次时，按 `stream_url` 实时显示团子回复，断线携带 Last-Event-ID 重连；仍兼容 `turn:null`。回复中可「停止」，保留已显示的 UTF-16 长度，落库后标注「已停止」。最新猫回复下可「重答」，也可长按任意可见成员消息请团子重答（包含伴侣的消息）；重答请求键按设备和消息持久保存，网络失败重试不换键。伴侣发起的群聊轮次通过轮询收最终回复，不主动开启流。

网络 DTO 使用显式 snake_case 字段，与统一后的宿主 JSON 一致，不再兼容 camelCase 响应；Keychain 的本机存储结构独立于网络 DTO，已有配对不受影响。默认 DevelopmentEchoReplier 一次返回开发回声，并非真实模型；查看明显的逐字流可在仓库外脚本调用 startHost，注入遵守 signal 的慢速 Replier，不修改宿主源码。

R8.12 与 R8.15 补齐共享日记纸、成员增量与离线约定提醒。R8.16 在 v2 配对后通过同一固定 CA 通道连接共享小院。打开院子后可在信箱查看共享日记与本人的来信。长按地点后可邀请团子移动，在宿主确认的陪坐地点可以邀请陪坐。旁观时地点轨仍可浏览院子。见 [R8.16 iOS 共享小院桥接](../docs/决策/2026-11-22-R8.16-iOS共享小院桥接.md)。

运行协议测试：

```sh
xcodebuild -project ios/Maomao.xcodeproj -scheme Maomao -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' test
```

```
open ios/Maomao.xcodeproj
```

选一个 iPhone 模拟器（设计基准是 390 × 844，对应 iPhone 12–15 一档）直接 Run。
签名走 Automatic，`PRODUCT_BUNDLE_IDENTIFIER` 是 `com.maomao.app` —— 上真机改成你自己的 team 和 bundle id。

- 最低系统：**iOS 17.0**（用到 `UnevenRoundedRectangle`、`Layout`、零参 `onChange`）
- 竖屏专用
- Swift 5 语言模式

陪伴世界最近一次在 iPhone 17 Pro / iOS 26.5 Simulator 构建并运行验证是 2026-09-12（逐帧 v5 树窝与走路换向），记录原文（原文 2026-09-27 从当前版本删除，原件在 git 历史）；更早的 v4/v3/v2 记录同样已删。尚未完成 iOS 17 真机验收。

## Release 与 TestFlight 归档准备

先在仓库根目录运行 `pnpm --dir web install --frozen-lockfile`。Xcode 的「Build YardWeb」阶段在复制资源前执行 `pnpm --dir web build:ios`，不需要提交生成的 `Maomao/Resources/YardWeb`。生成器在该目录不存在时也保留资源引用。脚本补充 Homebrew、Volta、pnpm 常用路径，并在没有 pnpm 时尝试 Corepack；缺少工具会明确报错。Node.js 需 22.12+、pnpm 需 11。脚本需要读写网页工程，因此关闭用户脚本沙箱。

版本默认 `0.1` / `1`，每次上传用命令行覆盖，不必改工程；Info.plist 从 `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` 展开：

```sh
xcodebuild -project ios/Maomao.xcodeproj -scheme Maomao \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$HOME/Maomao.xcarchive" \
  CURRENT_PROJECT_VERSION=42 MARKETING_VERSION=0.1 archive
```

命令仍需操作者已有的签名配置；本次不修改 bundle ID、Team 或签名，也不登录 Apple 账号、不上传。无签名模拟器验证：

```sh
xcodebuild -project ios/Maomao.xcodeproj -scheme Maomao \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CURRENT_PROJECT_VERSION=7 build CODE_SIGNING_ALLOWED=NO
```

开发时可加 `SKIP_YARD_WEB_BUILD=1` 复用已有网页；如果 `YardWeb/app.html` 不存在则报错。正式上传不要跳过，以免带入旧网页。

`generate_project.py` 同时生成工程与 `Maomao/Info.plist`，后者声明 `ITSAppUsesNonExemptEncryption=false`。隐私清单作为应用资源复制：UserDefaults 用于本机设置和恢复（CA92.1）；`WorldEngine`、`WorldBridge` 等使用 `systemUptime` 计算时间间隔（35F9.1）。检索未发现文件时间戳、磁盘余量、键盘列表等其它必需理由 API。

数据声明按现有远端路径覆盖：Apple 登录账号标识（`IdentityAPI`），以及聊天、日记、记忆和猫资料（`Backend` / `DiaryAPI`）用于 App 功能，关联账号且不用于跟踪。约定提醒改为手机本机通知，不再登记 APNs token；只排已同步的未来亲口约定，按约定时区将安静时段顺延到九点，最多保留最近 64 条（为其它本机通知留出名额）。电脑断连时保留已排通知和已加载聊天、信件，打开 App 再尝试同步；未同步的改期或取消无法离线获知。天气使用大致位置向 Open-Meteo 即时取天气，客户端不保存坐标；不将仅即时处理的位置声明为持久收集。无广告或分析 SDK。发布者仍需按实际服务端保留策略和第三方服务条款核对 App Store 隐私问卷；清单不代替该审核。

### 文件列表变了怎么办

`Maomao.xcodeproj/project.pbxproj` 是脚本生成的。平时在 Xcode 里增删文件正常操作即可；
如果想从磁盘重建整个文件列表（比如批量搬目录之后）：

```
cd ios && python3 generate_project.py
```

对象 id 是按路径 md5 定的，重跑结果逐字节一致，diff 不会炸。

## 结构

```
Maomao/
  App/           入口、根视图（路由 + 轻提示 + 信箱抽纸 / 我的 sheet 叠放）
  DesignSystem/  色板、字体、尺寸令牌、矢量图标
  Model/         地点、消息、碎片、气质与特征、种子数据；世界层：场景、猫的模拟、树窝等交互阶段、镜头、动作目录
  Backend/       聊天走本地模拟还是本机后端（server/）
  Store/         AppStore —— 全部状态与状态转换；WorldEngine 驱动世界层时钟，WorldTextureCache 按镜头加载贴图
  Features/
    Home/        陪伴主页、地点轨、世界层画布
    Chat/        专注聊天、消息行、长按菜单、光斑背景
    Diary/       日记纸（信箱里抽出来）、碎片行（团子来过三态）、记一下抽屉
    Me/          我的
    Onboarding/  欢迎 / 选外观 / 气质 / 命名 / 初次见面
    Shell/       通用零件（含信箱抽纸容器 PaperSheet）
  Debug/         调试面板（#if DEBUG）
  Assets.xcassets 团子表情、世界层动作帧（world-v2…v5）、动作目录 cat-actions-v2、场景配置 world-scene-v4 及备用链
  Resources/WorldTextures 世界层地块与物件贴图
```

状态全部集中在 `AppStore`（`@MainActor` 的 `ObservableObject`），界面只读它、只调它的方法。
交接文档里列的每个状态字段都在，命名对得上。

## 设计令牌落在哪

| 交接文档 | 代码 |
|---|---|
| 配色方案 B 全套色值 | `DesignSystem/Palette.swift` |
| 字号 / 衬线字体 / 行高 / 字距 | `DesignSystem/Typography.swift`，字距用 `track(em, size)` 折算 |
| 圆角 / 间距 / 点按高度 / 动效时长 | `DesignSystem/Metrics.swift` |
| 手绘线性图标 | `DesignSystem/Icons.swift`，SVG 路径逐条搬成 `Path` |
| 各地点落脚点（长卷归一化坐标）、状态句、反应句 | `Model/Location.swift`；世界层几何以场景配置 `world-scene-v4` 为准 |
| 语料池、名字池、三档解释 | `Model/ChatMessage.swift` |
| 种子数据（四条碎片、五条消息） | `Model/DiaryEntry.swift` |

图标**没有**换成 SF Symbols —— 交接文档明确写了「非任何图标库」，
换成系统图标会把这套院子的手绘笔触冲掉。所有路径都在 24 × 24 设计空间里写，
`VectorIcon` 负责缩放，描边宽度跟着缩。

## 和原型不一样的地方

都是移植到原生时必须做的判断，逐条列出来备查：

1. **字体**。设计稿用 Noto Serif SC，那是 Google Web Font，iOS 不自带。
   现在退到系统自带的 **Songti SC**（同属思源宋体一路，字面略宽）。
   把 `NotoSerifSC-Medium/Bold` 加进 target 并在 Info.plist 的 `UIAppFonts` 里登记，
   `Typo.serif` 会自动改用它，**代码一行都不用改**。这是唯一影响保真度的替换。

2. **底部安全区**（Tab 栏已于 09-10 拆掉，这一条只剩顶部规则有效）。设计稿把 Tab 栏底部写死成 22pt —— Web 画框里没有真的 Home Indicator。
   真机取 `max(安全区, 22)`：参考机型看着和设计稿一致，带 Home Indicator 的机器也不会压上去。
   顶部同理，`designTopInset` 取 `max(设计值, 安全区 + 5)`，在参考机型上恒等于设计值。

3. **日记「记一下」按钮**（已随 Tab 栏拆除而过时，日记改为信箱抽纸）。原型里它被绝对定位的 Tab 栏盖住了（Web 端的定位疏漏）。
   这里给它让出了 Tab 栏的高度。「我的」页底部同样让了位，最后一个分区能滚干净。

4. **回复超时后重试**。原型把「……」气泡留在原地又追加一条新回复，看起来像猫说了两次。
   这里改成先撤掉超时气泡再重发前一句。

5. **长按菜单**。原型受运行时限制用的是单击；这里是真的 `onLongPressGesture`。
   「复制」接了 `UIPasteboard`，「删除」真的删本地这条（标了 `TODO: 后端`）。
   「反馈」还是空的 —— 上报格式交接文档里没写。

6. **聊天背景光斑**。CSS 的 `radial-gradient` 能分别给横竖半径，SwiftUI 的 `RadialGradient` 只有一个半径。
   这里画正圆再按比例拉成椭圆，四层光斑的中心、半径、渐隐位置和设计稿逐个对齐。

7. **状态句轮换**。原型里 `statusIdx` 恒为 0，永远只显示第一句；
   交接文档写的是「随机一句」，这里按文档来：猫每次换地点时随机取一句。

8. **深色模式**。全套令牌只有浅色一版，根视图锁 `.preferredColorScheme(.light)`。
   要做深色得先补一套令牌。

## 调试面板

`#if DEBUG` 里才有，Release 构建整个文件是空的。

原型是手机右边一块常驻面板；真机上没有那块地方，所以收成右上角一枚 `DEBUG` 小胶囊，
点开是底部抽屉。胶囊上的 `×` 可以把它收成一个几乎看不见的小点，再点一下又出来 ——
不会挡界面，也不会找不回来（状态存在 `UserDefaults` 的 `debug.chipVisible`）。

能做的事和原型一样：搬猫换地点、推进团子来过三态、全部回到未读、
强制下一条发送失败 / 回复超时、触发话题卡与新记录点、从零走创建流程、重置种子数据。

## 后端接入点

**聊天已经能接本机后端（09-12）。** 后端在仓库根目录的 `server/`，怎么跑见 `server/README.md`。
调试面板最上面的「后端」切到「本机后端 localhost:8787」，填上 `pnpm create-dev-user` 生成的 token 就行；
不切就还是本地 mock。网络层在 `Backend/Backend.swift`，聊天接后端的逻辑在 `Store/AppStore+Remote.swift`，
气泡状态和服务端事件的对应见 `docs/方案/后端-开发者版-方案-2026-09-11.md` 第 8 节。

已接：发送、流式、停止、重试、断线续传、「记下了」、「不要再提」、「我的」页的记忆数和边界数、创建流程写猫的设定。
还是本地 mock 的（代码里标了 `TODO: 后端`）：

- **世界状态** —— 猫位置 + 状态句（`moveCat`）
- **日记碎片** —— 文字与猫日记本机按日落盘、日期回看、失败保留草稿；后端模式接账号同步/逐条读取许可/读取留言/来源聊天/撤回，私密不进模型。`advanceVisit` 仅调试，正常页面不展示演示记录。
- **记忆条目的查看、修改** —— 二级页还没做；后端已有 `GET /v1/memories`、`DELETE /v1/memories/:id`
- **消息的删除、反馈**

语音转写、记忆抽取、模型调用都在后端，前端只消费结果。

## 本版未做

跟交接文档的「本版未做」一致，代码里对应位置都标了 `TODO: 二级页`：

记忆条目列表与编辑、在聊话题列表、不要再提列表、相处分寸设置、数据导出与删除、
通知与声音详情页、显示与无障碍详情页、登录流程、聊天顶栏的「记录」入口、日记的搜索与折叠。

## 资产缺口

- **奶牛猫 / 黑猫 / 三花**三种外观待美术定稿。现在按设计稿画成占位灰圆、名称降级、不可点，
  说明尾部带「· 待定稿」。定稿后往 `Assets.xcassets` 加图，改 `CatAppearance.all` 的 `ready` 即可。
- **聊天头像**用的是全身图缩到 34pt，效果偏「橘色团块」。建议补一版头部裁切图，
  换掉 `MessageRow.avatarSlot` 里的图名就行。
- **App 图标**是空的占位 `AppIcon.appiconset`。

## 第 1 轮独立构图预览（09-26）

Debug 面板 → **3D 构图预览**；或启动参数 `-yardComposition`。场景是打包内的 3D 院子，保留原 2D 首页；首次设置截图机位，之后地点轨、全景与找团子只改变镜头。

- `-yardCompositionView house|bed|tree|grass|pond|fence|overview`：首次机位及截图猫位置。
- `-yardCompositionTime day|night`：白天晴或夜雨；`-yardCompositionUI YES|NO`：显示/隐藏评审控件。
- `-yardCompositionDemo YES`：程序驱动镜头演示，不是人工触摸证据。
- `-yardCompositionRecovery YES`：缩放浏览后的原生内容进程终止回调注入，不是真实系统杀进程。
- `-yardCompositionDuration 60`：60 秒渲染后自动保存量测并暂停；0 为不自动暂停。
- 量测写入 App 的 `Documents/yard-composition/`，失败会显示错误。真机截图、报告与边界见 [构图验收](../outputs/ios-3d-composition-review/验收报告.md)。

扩院预览（09-26）：新增 `-yardCompositionView comparison` 固定旧机位作前后比较；`-yardCompositionStroll YES` 以正常步速走扩展路线，也可从头像菜单启动。`tools/check_yard_expansion.py` 收集真机近景、夜雨全景、散步及回调恢复证据；截图脚本通过 `--output outputs/yard-expansion-review` 指定新目录。第二次布局图使用 `--output outputs/yard-layout-review`；详见 [最新布局验收](../outputs/yard-layout-review/验收报告.md)，原2D首页保留。

## 正式 3D 首页（2026-10-05）

普通入口默认3D；`YardIntent` 选择活动，`YardRuntime` 连接共享网页宿主，网页回传真正的位置/姿势/到达。聊天保持同一世界活跃；后台暂停。`-world 2d` 为保留回退。构建前先 `pnpm --dir web build:ios`；详见[本轮验收](../outputs/yard-home-review/验收报告.md)。

## 原生页面与3D配套（2026-10-13）

聊天使用60张正式3D场景取景，头像及创建预览由同一GLB渲染；`PageBackground`统一原生米白毛毡与淡蓝光晕，纯色控件使用`Palette.inset/card`。键盘与长草稿在模拟器复核，真机暂缓；本轮页面观感已获用户确认，头像歪头动画已获确认，大头照图标方向已否决，小窗方向亦被否决；已选定第三款手绘趴姿符号并接入常规图标，模拟器主屏幕与四种图标外观已复核。上文旧头像、聊天背景和假入口描述仅对应历史版本。素材复现与验收见[报告](../outputs/native-ui-review/验收报告.md)。
