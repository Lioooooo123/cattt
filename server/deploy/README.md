# 第五段测试部署与本机演练

> 2026-11-19 起不再以云部署为目标，见[本地优先](../../docs/决策/2026-11-19-本地优先.md)；本目录的去留由电脑端打包那一批决定。

本目录是可使用的部署包，不代表已有云测试环境。云账号、地区、主机、域名和托管PG尚未确定；不要把开发库作为测试部署库。没有自动部署工作流，也没有操作任何Apple或云账户。

## 镜像与配置

在仓库根目录构建：

```sh
docker build -t <registry>/cattt:<immutable-version> server
```

同一个镜像用默认命令启动API，用 `node --import tsx src/worker.ts` 启动worker，用 `pnpm db:migrate` 执行增量迁移。镜像使用Node 24、pnpm 11.11.0、非root用户；源码中的`.env`、node_modules和密钥目录不进镜像。当前本机镜像为linux/arm64，云主机架构确定后需要按目标架构重新构建，不把本机架构当作部署前提。

为 `compose.staging.yml` 提供环境文件，路径留在仓库外并限制为当前用户可读：

| 变量 | 含义 |
|---|---|
| `CATTT_IMAGE` | 不可变镜像标签或digest，API/worker/migrate共用 |
| `APP_ENV` | staging或production；两者均不接受开发者token |
| `DATABASE_URL` | 独立测试环境的PG地址，不能指向开发库 |
| `SITE_HOST` | 已配置DNS的HTTPS域名，Caddy反向代理并即时转发SSE |
| `MODEL_PROVIDER` / `MAOMAO_DEEPSEEK_API_KEY` | 真实环境明确选deepseek；本机验收明确选mock，不隐式降级 |
| `APPLE_CLIENT_ID` | 原生App ID对应的身份token audience，须与最终bundle ID一致 |
| `SESSION_DAYS` | 正式会话有效期，代码默认7天，最长30天 |
| `APNS_TOPIC` / `APNS_TEAM_ID` / `APNS_KEY_ID` | 已获准能力的topic、团队与推送key标识 |
| `APNS_PRIVATE_KEY_FILE` | 容器内只读p8路径，例如`/run/secrets/apns.p8`；真实文件由操作者放到忽略的`secrets/`目录，须允许容器uid 1000读取 |
| `MODEL_DAILY_CALL_LIMIT` / `MODEL_DAILY_TOKEN_LIMIT` | 每账号UTC日调用前预留上限，默认120次、2,000,000个保守token额度；两者任一耗尽即停止新模型请求 |
| `AGENT_ENABLED` | true正常运行；false停止时钟和主动处理器，新接单工具在当前代码中关闭；既有事项仍可读、可取消 |

APNs没有配置就保留PG待办并稍后再查，不把它标成sent，也不切换假发送。APNs测试传输只从测试代码函数参数注入；发布配置没有mock传输、替代JWKS、跳过签名或伪造身份的开关。SESSION_DAYS还可通过运行环境注入，compose默认沿用代码7天；密钥不要放进命令行、Git、镜像层或构建参数。

配置就绪后，先停旧代码，迁移后再启动新代码：

```sh
docker compose --env-file <environment-file> -f server/deploy/compose.staging.yml stop api worker
docker compose --env-file <environment-file> -f server/deploy/compose.staging.yml run --rm migrate
docker compose --env-file <environment-file> -f server/deploy/compose.staging.yml up -d --wait api worker proxy
```

API的 `/healthz` 检查PG；worker健康检查读取其15秒心跳文件，并实际查询PG。45秒无心跳即不健康。代理只公开HTTPS/HTTP重定向端口，API不直接公开宿主端口。托管PG的TLS、网络ACL、备份、容量和具体域名证书仍需在确定目标后配置并实际验证。

## 独立本机验收

`compose.local.yml` 是本机覆盖层：创建独立卷/网络的PG，绑定127.0.0.1的15432端口；API为8887，HTTPS为8843。它显式强制mock、development及空模型/APNs密钥，避免继承宿主凭证。本机夹具账号`cattt_test`和密码`local-only`仅用于这一隔离数据库，不能拿到云上。

在仓库外创建本机环境文件：

```dotenv
CATTT_IMAGE=cattt-phase5:current
APP_ENV=development
MODEL_PROVIDER=mock
DATABASE_URL=postgres://cattt_test:local-only@pg:5432/cattt_test
SITE_HOST=localhost
APNS_TOPIC=com.maomao.app
```

以两个compose文件运行上面相同的迁移与启动流程。`Caddyfile.local` 使用本机内部CA，不申请公网证书。可复制容器 `/data/caddy/pki/authorities/local/root.crt` 到临时文件后，使用 `curl --cacert <root.crt> https://localhost:8843/healthz` 验证HTTPS，验收不使用跳过证书校验。

主冒烟连接这个独立数据库和HTTPS入口：

```sh
DATABASE_URL=postgres://cattt_test:local-only@localhost:15432/cattt_test \
MODEL_PROVIDER=mock APNS_TOPIC=com.maomao.app \
BASE_URL=https://localhost:8843 NODE_EXTRA_CA_CERTS=<root.crt> pnpm --dir server smoke
```

当前主冒烟15项，涵盖聊天恢复、约定、托付、日记、正式会话、设备登记/注销与通知归属；设备token是本机夹具，未对APNs投递。HTTPS长SSE使用独立原生连接，避免Node fetch连接池把并发取消串在长流之后。另运行 `MODEL_PROVIDER=mock pnpm --dir server exec tsx scripts/smoke-identity.ts`，在127.0.0.1临时HTTP端口用临时RSA签名/JWKS验证Apple格式的JWT交换、重复登录、账号/聊天/日记和退出；这不是真实Apple账户登录。

## 代码回退

只回退到已经包含正式认证与撤回/阻断保护的镜像。不要直接把第四段开发者认证镜像暴露到正式入口。回退不执行向下迁移、不清空事项、不删数据卷：

```sh
sh server/deploy/rollback.sh <previous-image> --env-file <environment-file> -f server/deploy/compose.staging.yml
```

脚本停API/worker，再以旧镜像和 `AGENT_ENABLED=false` 启动，停止主动产出；检查健康、正式会话、既有事项读取/取消和日记后再决定恢复。恢复时使用环境文件中的当前镜像正常 `up -d --wait`。Compose优先读取shell里的同名变量；控制端连接宿主数据库的DATABASE_URL不能泄漏覆盖容器环境文件。

本机的 `scripts/rehearse-rollback.ts` 只允许localhost端点和15432隔离库。它在临时账号写一条日记，切到本轮保留的较早第五段镜像，再恢复当前镜像，核对健康、正式会话、日记和迁移数；子进程清除控制端同名URL变量。它证明的只是这两个本机镜像之间的代码回退，不证明托管云、数据库灾备、旧生产版本兼容或公网切流。

结束时执行compose `down`，不带`-v`。本轮验收卷、镜像、iOS构建缓存保留，临时账号/凭证/CA副本/日志清理。云部署前还须补真实托管环境迁移/回退演练。

## 推送收据的实际含义

`sent` 表示APNs已返回200接受，并不代表设备已经展示。每条通知/设备保留稳定apns-id和collapse-id；多设备共用一条通知及一天一次预算预留。明确429/5xx可重试，跨日重试重新占发送当天额度；410或错误device token停用对应登记。连接中断/进程在sending状态中断后，无法判断供应商是否接受，保留`uncertain`，不自动重发该设备；这可能漏提醒，但不会把未知结果伪称成功。PG与APNs之间没有原子恰好一次保证。

通知在每台设备发出前复核取消、原话、规则/授权版本、边界、日记修订、记忆许可和每日预算；跨入安静时段延期。最后一次PG复核与供应商接收之间仍有外部系统边界，已被APNs接受的通知不能由本系统撤回。日记、failed/blocked/dropped或过时waiting不推送；合并约定只建一条通知。

## Apple能力与外部验收缺项

iOS生成器维护Sign in with Apple和APNs entitlements，Debug选择development，Release选择production；通过 `CATTT_API_URL` 构建设置注入正式HTTPS端点。没有配置端点时显示未连接，不回退到localhost或开发者token。真实bundle/App ID、签名团队、provisioning profile及Apple后台能力尚未配置，模拟器构建不能证明这些能力可用。

尚需父代理取得非敏感目标：云/项目/地区、主机架构、测试域名、独立PG地址、最终bundle ID/audience、Team ID/Key ID和APNs环境。模型key与p8由父代理通过秘密输入流程取得；本轮不重复索取。之后必须实际核对原生Apple登录、退出/撤销、换账号/重登的本地档案、真实设备token、App关闭时收到推送、点推送到真实聊天/信件、失效token及公网回退。

## 协议与SDK依据

- Apple：[验证身份token](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)、[原生登录流程](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple)。服务端校验签名/JWKS、issuer、audience、exp、iat、一次性nonce；原生会话默认7天（配置上限30天），不保存Apple refresh token。iOS回前台检查本机Apple credential state；本段没有Apple授权码交换、服务端账户变更webhook或跨团队转移处理。
- Apple：[APNs令牌认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[HTTP/2请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)、[响应与失效时间](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)。使用ES256、kid/iss/iat，provider token缓存50分钟；410清理以设备更新时间和供应商失效时间比较，不使更新后的登记被旧响应停用。
- [jose官方实现与文档](https://github.com/panva/jose)：本机安装6.2.16，核对了 `jwtVerify/createRemoteJWKSet/createLocalJWKSet/SignJWT/importPKCS8` 类型；没有手拼签名。模型额度中间件按当前AI SDK 7.0.97和provider V4本机类型实现。

## 第六段增量

继续使用同一镜像和迁移流程；新增`0015_inference_observe`，不改0007–0014，不需要新增密钥或环境变量。`inference`队列现由API前台Router与pg-boss启动；`AGENT_ENABLED=false`阻止新推断和推断发布，已存事项仍可读/取消。账号许可是数据库字段、默认false，部署配置没有把ask_outcome切auto的参数。上线后仍需内测观察及另行决策，不能用本机mock数字批准auto。

本轮新镜像标签`cattt-phase6:current`已在上述独立本机环境验证；compose的历史项目名`cattt-phase5-local`只表示复用本机卷和网络，不表示运行旧代码。第六段主冒烟增为16项，包括HTTP许可与聊天→PG待办→新inference队列→observe聚合且无推断外发。第五段的真实Apple/APNs/云部署及云回退仍未验。


### 事件驱动版本（0018）

同一镜像仍只启动 API 和 worker。API 启动时注册前台 `report/followup/inference/push` 消费者；worker 负责执行与结构化汇报。先同时停止旧 API/worker，运行迁移 `0018_worker_reports`，再启动新版本。API 停机时，已完成计算保留为 PG 汇报，不由 worker 直接投递给用户；恢复 API 后继续消费。

`AGENT_ENABLED=false` 继续暂停主动处理及待办消费；原有许可日记阅读仍按用户分享执行，已生成的汇报等待前台恢复后发布。回退须同时停止新处理器；旧 API 不支持新 `report` 协议，不能将混跑或健康接口200当成汇报恢复成功。保留新增表和待办，恢复支持该协议的版本后检查未消费汇报。
