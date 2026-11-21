# macOS DMG 发布 / Release

在 Apple Silicon、macOS 14+ 上安装 Xcode 命令行工具、Node 22、pnpm 11 后运行 / On an Apple Silicon Mac with Xcode CLI tools, Node 22 and pnpm 11:

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
CATTT_VERSION=0.1.0 bash desktop/macos/scripts/package-dmg.sh
```

输出 / Output: `desktop/macos/build/Cattt-0.1.0-arm64.dmg`，包含应用与 Applications 快捷方式。最低 macOS 14；仅 arm64（随附 Node 为 arm64，不声称 universal）。无现成 macOS 图标，不借用 iOS 图标。版本必须为 `X.Y.Z`。

The DMG contains Cattt.app and an Applications symlink. Minimum macOS 14, arm64 only (the bundled Node is arm64). No macOS icon is currently supplied. Versions must be `X.Y.Z`.

## 凭据 / Credentials

仅通过环境变量或 GitHub 仓库 Settings → Secrets and variables → Actions 传入；不要提交文件或打印值。需要 Apple Developer Program 会员。/ Supply only through environment variables or GitHub Actions repository secrets; never commit or print them. Apple Developer Program membership is required.

| Secret | 获取方式 / Source |
| --- | --- |
| `APPLE_DEVELOPER_ID_APPLICATION` | 钥匙串中完整的 `Developer ID Application: … (TEAMID)` 名称；Apple Developer → Certificates 创建 Developer ID Application 证书 / Full signing identity name from Keychain Access; create a Developer ID Application certificate in the developer portal. |
| `APPLE_CERTIFICATE_P12_BASE64` | 在钥匙串访问中将证书和私钥导出为加密 .p12，再 base64 编码 / Export certificate **and private key** as password-protected .p12 from Keychain Access, then base64 encode. |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设置的密码 / Password chosen during .p12 export. |
| `APPLE_NOTARY_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API 创建具有 Developer 权限的团队 API key，记录 Key ID / Create a team API key with Developer access and record its Key ID. |
| `APPLE_NOTARY_ISSUER_ID` | 同一 API 页面上的 Issuer ID / Issuer ID from the same API page. |
| `APPLE_NOTARY_KEY_P8_BASE64` | 下载一次的 AuthKey .p8 的 base64 编码 / Base64 of the one-time downloaded AuthKey .p8. |

证书只导入临时钥匙串，脚本退出时删除钥匙串和临时凭据。不改默认钥匙串或搜索列表。完整签名凭据缺失时使用 ad hoc；公证凭据缺失时保留 Developer ID 签名但跳过公证。两种情况下都明确跳过 stapler 和 spctl，并产出开发 DMG；错误凭据或公证拒绝会使构建失败，不静默降级。

Certificates are imported into a temporary keychain and removed with temporary credentials on exit. The default keychain/search list is untouched. Missing signing credentials select ad hoc signing; missing notary credentials skip notarization. Both paths explicitly skip stapling and Gatekeeper assessment and still produce a development DMG. Invalid credentials or notarization rejection fail the build rather than silently downgrade.

## 签名边界 / Signing scope

逐个签名所有 Mach-O（包含 PostgreSQL 动态库及工具），最后签名外层应用与 DMG；Developer ID 使用 hardened runtime 和安全时间戳。应用无 App Sandbox，不需要 network.client/server 权限；这些是沙盒权限，不应无故添加。只有 Node/V8 获得 `allow-jit`（MAP_JIT），没有 unsigned-executable-memory、disable-library-validation 或继承权限。WKWebView 的 JavaScript 在系统 WebKit 进程运行，无需给 Swift 应用 JIT 权限。PostgreSQL 不带启用 LLVM JIT 所需的额外授权。

All Mach-O files, including PostgreSQL tools and libraries, are signed inside-out before the app and DMG. Developer ID uses hardened runtime and timestamps. This is not a sandboxed app, so sandbox network entitlements are unnecessary. Only Node/V8 gets `allow-jit` for MAP_JIT; no unsigned-memory or library-validation bypass. WKWebView uses system WebKit processes, so the Swift executable needs no JIT entitlement. No additional entitlement is granted for PostgreSQL LLVM JIT.

开发例外：ad hoc 签名没有 Team ID，hardened runtime 无法把 PostgreSQL 与其动态库认作同一团队，因此仅无证书开发构建中的 PostgreSQL 代码增加 `disable-library-validation`。正式 Developer ID 构建使用同一身份签名所有组件，不加这个豁免。

Development exception: ad hoc signatures have no Team ID, so hardened runtime rejects PostgreSQL's bundled libraries despite matching ad hoc signatures. Only PostgreSQL code in the no-certificate development build receives `disable-library-validation`. Developer ID builds sign all components with one identity and do not get this exception.

完整凭据下先公证 ZIP 并 staple 应用，再制作和签名 DMG、公证并 staple DMG，最后运行 codesign、spctl 与 stapler validate。/ With complete credentials the script notarizes a ZIP and staples the app, then builds, signs, notarizes and staples the DMG, and verifies with codesign, spctl and stapler validate.

运行时内置 YardWeb、Node、PostgreSQL、打包 API/worker/迁移/模型安装脚本及数据库迁移。无需 Docker、Redis、pnpm 或网页开发服务器。模型权重和 Ollama **不内置**；首次在设置里安装/连接本地模型，或提供自己的 DeepSeek key。数据保存在 `~/Library/Application Support/Cattt`，升级不会覆盖。

Runtime includes YardWeb, Node, PostgreSQL, bundled API/worker/migration/model-setup scripts and DB migrations. Docker, Redis, pnpm and a web dev server are not needed. **Model weights and Ollama are not bundled**; configure/install a local model or supply your own DeepSeek key. User data lives in `~/Library/Application Support/Cattt`, outside the app.

## GitHub Actions

手动运行 `macOS DMG`（填写版本），或推送 `mac-vX.Y.Z` tag；下载 `Cattt-macOS-arm64` artifact。不在 PR 上运行，不自动创建 Release。/ Dispatch `macOS DMG` with a version, or push a `mac-vX.Y.Z` tag. Download the `Cattt-macOS-arm64` artifact. It does not run on PRs or create a GitHub Release.

## 未公证开发 DMG 的首次启动

1. 打开 DMG，把 Cattt.app 拖到 Applications（应用程序），弹出磁盘镜像。
2. 在应用程序中右键或 Control-click Cattt，选择「打开」。
3. 若仍被拦截（包括 macOS 15+），先尝试打开一次，再进入「系统设置 → 隐私与安全性 → 仍要打开」，确认来源后打开。
4. 仅在确认这是可信开发构建时，也可只移除这个应用的隔离标记：

   ```sh
   xattr -dr com.apple.quarantine /Applications/Cattt.app
   ```

不要关闭整个系统的 Gatekeeper。开发签名不等于 Apple 公证。

For an unnotarized development build, drag the app to Applications and use Control-click → Open, or System Settings → Privacy & Security → Open Anyway. Only for a trusted build, the app-specific quarantine command above is an alternative. Never disable system-wide Gatekeeper.
