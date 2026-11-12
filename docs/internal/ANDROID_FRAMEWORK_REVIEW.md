# Android框架与兼容性评审

状态：P0评审稿，尚未正式选定框架或最低支持版本。初始评审基线为`08b9ade`；后续实验源码与版本以PROJECT_STATUS为准；运行证据统一见[PROJECT_STATUS](PROJECT_STATUS.md)，复现步骤见[MAINTAINING](MAINTAINING.md)。本页承担选择依据与验证顺序，不另维护完整任务状态。

## 建议与已确认的约束

建议继续以固定版本Capacitor8.6.0为主候选，保持独立静态界面／可移植领域代码与Android存储、传输、凭据适配分离。现有证据足以继续调查这条路线，尚不足以证明完整业务迁移成本或正式支持范围。SQLite、SSE和Keystore探针只验证机制，不能直接升格为产品接口。

用户本轮确认：优先验证**旧Android＋可更新WebView**，旧内核保留评估项。这不是排除旧内核、接受某个最低系统或批准正式框架。不按个人机型缩窄开源范围，不要求电脑在线，不加入常驻应用服务器／云存储，不删除规划、回顾或高级工程。

只读核对了电脑仓库文档固定提交`7e2bb600e030385398cbf1e2dc9c59d4d6d7a850`的[能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/7e2bb600e030385398cbf1e2dc9c59d4d6d7a850/docs/internal/MOBILE_CAPABILITIES.md)与[跨端计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/7e2bb600e030385398cbf1e2dc9c59d4d6d7a850/docs/internal/MOBILE_CONTINUITY_PLAN.md)。84个接口声明仍须按LOCAL／ONLINE／MIXED／DEVICE保留目标能力；它们不是84项已完成移植。未导入上游源码、修改电脑仓库或更新共享快照。

## 三种门槛必须分开

| 维度 | 框架／构建声明 | 当前应用实际依赖与证据 | 不能推导的结论 |
| --- | --- | --- | --- |
| Android系统 | 固定候选生成`minSdk=24`、compile／target36 | API30／35搭配WebView124、API33搭配官方109、API36搭配官方133已有原型证据；API26/default提供方策略阻塞；Google API24／26的Chrome69启动保护及Chrome119／x86及x86_64进程完整原型路径已验证 | `minSdk=24`不是本项目已支持Android7；API26环境阻塞也不等于应用不支持Android8 |
| WebView | 固定源码默认检查Chrome内核60；低于配置门槛且无错误页时仅记录错误后继续加载 | 页面原样打包ES模块（含顶层await）、可选链和`crypto.randomUUID`；组件快照使用`@layer`。API30自带83缺少所需能力，启动保护明确提示更新并禁写；更新124后通过 | 框架能启动，不代表当前JS能解析、按钮能操作或样式完整；本构建拒绝写入不等于正式放弃旧内核 |
| Java API | JDK21／AGP8.13／D8将源码转换为DEX | `Set.of`的平台API是30，但本轮检查基线debug APK，调用已转换到`ExternalSyntheticBackport`和旧版集合实现 | 不能只看源码方法的引入版本就断言必然崩溃；也不能据这一项断言全应用兼容API24 |
| ABI | 当前APK没有自带`.so`，生成配置没有主动限制ABI | 已有API24／26同版本Chrome119的x86／app_process32及x86_64／app_process64完整路径证据；API26的64位进程加载32位WebView明确失败 | 无自带native库不等于任意WebView ABI可用；单台ARM64／API36真机的本地、USB虚构HTTP／TLS及凭据冷读通过；后续插件可能改变范围 |
| 本地数据 | 原生事务、同ID重放、强停恢复已有虚构记录证据 | 正式消费写入、日期／预约保护、历史、迁移与磁盘失败尚未设计完整 | 固定123分不能当正式账本或同步写入接口 |
| 在线调用 | 普通POST、受控SSE、TLS连接取消／超时、总时限与错误证书已有证据 | 测试地址仅是本地虚构对端；API24／35受控SYN取消通过，DNS挂起时取消与硬总时限未满足；真实供应商、VPN及真机切网仍有缺口 | 不保证任意网络阶段可即时取消，也不保证供应商支持事件续传 |
| 凭据 | 平台Keystore＋AES-GCM虚构值保存、重读和损坏报错已验证 | 单台ARM64真机已补公开虚构凭据存取／冷读；正式输入、失效、硬件背书、卸载与设备迁移策略待评审 | 模拟器与编译进实验的公开token不是完整安全方案 |

[Capacitor Android说明](https://capacitorjs.com/docs/android)给出框架层门槛；以固定依赖源码`Bridge.java`、`CapConfig.java`和生成的`variables.gradle`核对，不能把网页上的最新框架说明当成本仓库已升级。工具链要求见[Capacitor8升级说明](https://capacitorjs.com/docs/updating/8-0)。

当前样式的`@layer`在Chromium99引入，见[Chrome官方说明](https://developer.chrome.com/blog/new-in-chrome-99/)；旧内核会忽略这个规则块。`crypto.randomUUID`还有安全上下文要求，见[API说明](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)。这些是**待验证的功能交集**，不是把正式最低WebView直接定成99：其他语法、提供方实现、样式状态与Android版本仍需实测。`color-mix`和独立`scale`缺失应单列为增强效果差异，不能与基本数据能力混成一个版本号。

原生API检查依据为[Android Set API](https://developer.android.com/reference/java/util/Set)和[D8／desugaring说明](https://developer.android.com/studio/write/java8-support)，本轮DEX检查确认了特定调用的转换。源码lint分析发现的debug域缺少`includeSubdomains`已显式设为`false`，不扩大测试CA或明文例外；完整debug lint加入CI，不能只靠release的vital检查覆盖debug资源。

## 实质取舍

| 路线 | 当前可以复用 | 必须承担的成本／未知 | 本轮判断 |
| --- | --- | --- | --- |
| Capacitor＋Android适配 | TS只读领域、共享语义token与组件状态；已有独立构建和原生机制探针 | 需要独立移动入口、实际业务执行层与可靠存储；自行维护桥接与生命周期；同时验证OS和WebView。现有Next服务器路由／SSR／Python不能直接装入APK | 继续作为主候选补旧系统组合证据；不据原型正式定型 |
| 原生Android UI（如Kotlin／Compose） | 数据契约、参考样例、业务语义和Android平台机制；样式语义可映射 | Web组件和TS界面不能原样复用；领域实现若换语言须重新过同一契约样例；完整业务执行仍需移植。尚无本仓库对照原型 | 若可更新WebView仍出现不可接受的兼容／生命周期障碍，或用户要求无法更新的旧内核也必须支持，再做同场景对照，不先全量重写 |

[Compose官方入口](https://developer.android.com/compose)说明的是原生UI工具，并不自动解决TravelFlow业务迁移或数据协议。以上成本比较是基于当前代码边界的工程判断，未测工期、性能或正式包体积，不将原生路线写成已验证更优。PWA／电脑网页入口继续保留在原仓库，但不据现有网页访问证明Android独立离线、文件与安全存储目标已满足。

## DNS取消与正式凭据的待定方案

2026-11-12的受控实验已证明：API24／35上`HttpURLConnection.disconnect()`能中断本次SYN等待，但不能让正在挂起的系统DNS立即结束；6000ms总时限只设置停止原因，工作线程仍须等待解析返回。已有实验保留“线程退出后才发单终态”，不会为缩短表面时间提前宣布关闭。下一项应先补可取消解析与传输组合，不能直接把当前ProbeStream升格为正式适配器，也不能只换一个带cancel方法的库便宣布解决。

[Android DnsResolver](https://developer.android.com/reference/android/net/DnsResolver)从API29提供带CancellationSignal的异步查询，可作为新系统候选；API24／26需要另评估兼容方案。API存在不等于已经与HTTP／TLS正确集成：仍须保留域名、SNI及证书验证、网络选择和代理语义，并用同一受控DNS场景证明取消后资源回收与单终态。不能仅把业务URL改成IP来绕过原问题。以上是下一步调查方向，尚未新增HTTP库、解析器或改变最低版本，也未让用户接受DNS阶段延迟作为降级。

正式凭据生命周期目前只有下列**评审建议，尚未实现或获用户确认**；固定公开token实验不代表这些能力完成：

| 环节 | 建议行为与验收目标 | 尚需确认／验证 |
| --- | --- | --- |
| 输入与保存 | 正式值不编译入包；应用内原生凭据适配只暴露引用与状态，界面、日志、账本、同步不返回秘密；按供应商／版本独立管理 | 正式输入交互、内存生命周期及供应商授权契约 |
| 更新与轮换 | 新值完整持久化后再切换引用；失败保留原可用值，旧材料仅在切换确认后清理 | 原子更新、崩溃恢复、失效反馈；不以真实付费调用自动验证 |
| 缺失／损坏／失效 | 明确停止相应联网调用并提示重新输入，不静默覆盖或删除密文；本地旅行与账本继续可用 | 失败状态、用户恢复路径与数据保护验收 |
| 删除 | 用户明确操作后使引用失效并取消相关调用，再清理专用密文／密钥；清理失败不能报告成功，不动旅行业务数据 | 删除交互、并发请求及部分失败重试 |
| 跨设备／重装 | 默认不把秘密加入同步／导出，设计重新输入流程；密钥迁移和备份另列策略 | 用户体验、卸载／重装／设备迁移的实际验收 |
| 解锁与硬件保护 | 按实际能力记录保护等级；硬件背书和每次解锁均不从Keystore可用直接推导 | 是否要求每次认证、锁屏时联网需求及旧设备支持取舍 |

[官方Keystore说明](https://developer.android.com/privacy-and-security/keystore)要求按实际KeyInfo能力区分硬件保护；[KeyGenParameterSpec.Builder](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder)说明用户认证会约束密钥使用，并可能因锁屏配置变化失效。因此不能在没有需求判断时直接开启强制认证或硬件门槛；这会影响旧设备与锁屏调用。该提案需在正式实现前确认，当前仅保留公开虚构凭据证据。

## 验证顺序与收口条件

1. **先固定引擎、改变OS。** API35与API30均使用WebView124；API24／26新增对照固定同一Chrome119 x86与原型APK，仅改变官方系统镜像，11月12日补齐同版本双ABI分包的两组64位进程路径；32位与64位分开计数；API30自带83的能力不足已复现，更新后再跑存储与网络路径。API26/default镜像允许的Chrome／Google提供方与自带`com.android.webview`不匹配，创建WebView前即失败，因此保留为环境阻塞；未改系统白名单来制造通过。更新仅限自己的隔离模拟器，不操作真机或宿主全局配置，不把过时测试内核推荐给真实用户。
2. **再补系统／引擎边界。** API24仍为候选声明的待核对下界，不因API26通过就删除；Google镜像的Chrome69已进入启动保护；API33官方109组件minSdk29且依赖Trichrome，不能用于API24／26。用户已授权第三方原版APK，仅用于隔离模拟器；已从第三方来源取得Chrome119 x86，核验与官方同包签名一致，API24／26在官方32位镜像完整原型路径通过；既有64位API26加载该32位库失败，不能据安装／提供方选中宣布可用。API33／官方109组合已补存储、网络、凭据与断网冷启动证据（见PROJECT_STATUS），尚非固定引擎对照；API36／WebView133模拟器已补网络与本地路径，单台ARM64真机已补本地、USB虚构HTTP／TLS与凭据冷读，映射缺失时仍可保存；旧系统64位引擎已补两组，后续解决已复现的DNS真正取消／硬时限缺口，评审正式凭据策略；公网及真机切网仍未验；上述组合不是所有Android7／8设备支持声明。若旧内核缺少当前资源所需能力，比较构建时转译／样式适配与明确提示的成本，再决定正式版本政策；不直接删除有来源的设计快照或降低网络安全校验。
3. **每一组都走有副作用的实际路径。** 本地保存／同ID重放、断网强停冷启动、HTTP／SSE、HTTPS证书拒绝、TLS连接／读取取消和超时、凭据保存／重读／失败。原有金额不得归零，失败不能显示成功。功能检测脚本只记录当前WebView能力，不替代这一步。
4. **形成用户可决定的支持提案。** 分别列出已构建、模拟器通过、真机通过和未验证的组合；用户确认目标与剩余风险后才记录框架决定和拟支持范围。正式支持声明与发布还需权限、文件、后台／省电、升级、存储失败和完整旅程验收，不能提前把P4／P5写成完成。

本次评审不启动P1大面积迁移、不修改同步契约。独立连接与完整业务执行仍按跨仓计划分工推进；需要电脑配合时先给带版本的接口差异与联合验收条件。
