# Android框架与兼容性评审

状态：P0评审稿，尚未正式选定框架或最低支持版本。基线为`e6ebf8c`及本轮debug网络配置修复；运行证据统一见[PROJECT_STATUS](PROJECT_STATUS.md)，复现步骤见[MAINTAINING](MAINTAINING.md)。本页承担选择依据与验证顺序，不另维护完整任务状态。

## 建议与已确认的约束

建议继续以固定版本Capacitor8.6.0为主候选，保持独立静态界面／可移植领域代码与Android存储、传输、凭据适配分离。现有证据足以继续调查这条路线，尚不足以证明完整业务迁移成本或正式支持范围。SQLite、SSE和Keystore探针只验证机制，不能直接升格为产品接口。

用户本轮确认：优先验证**旧Android＋可更新WebView**，旧内核保留评估项。这不是排除旧内核、接受某个最低系统或批准正式框架。不按个人机型缩窄开源范围，不要求电脑在线，不加入常驻应用服务器／云存储，不删除规划、回顾或高级工程。

只读核对了电脑仓库文档固定提交`7e2bb600e030385398cbf1e2dc9c59d4d6d7a850`的[能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/7e2bb600e030385398cbf1e2dc9c59d4d6d7a850/docs/internal/MOBILE_CAPABILITIES.md)与[跨端计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/7e2bb600e030385398cbf1e2dc9c59d4d6d7a850/docs/internal/MOBILE_CONTINUITY_PLAN.md)。84个接口声明仍须按LOCAL／ONLINE／MIXED／DEVICE保留目标能力；它们不是84项已完成移植。未导入上游源码、修改电脑仓库或更新共享快照。

## 三种门槛必须分开

| 维度 | 框架／构建声明 | 当前应用实际依赖与证据 | 不能推导的结论 |
| --- | --- | --- | --- |
| Android系统 | 固定候选生成`minSdk=24`、compile／target36 | API30／35搭配WebView124已有证据；API26镜像的提供方策略阻塞，API24未跑 | `minSdk=24`不是本项目已支持Android7；API26环境阻塞也不等于应用不支持Android8 |
| WebView | 固定源码默认检查Chrome内核60；低于配置门槛且无错误页时仅记录错误后继续加载 | 页面原样打包ES模块（含顶层await）、可选链和`crypto.randomUUID`；组件快照使用`@layer`。API30自带83缺少所需能力，启动保护明确提示更新并禁写；更新124后通过 | 框架能启动，不代表当前JS能解析、按钮能操作或样式完整；本构建拒绝写入不等于正式放弃旧内核 |
| Java API | JDK21／AGP8.13／D8将源码转换为DEX | `Set.of`的平台API是30，但本轮检查基线debug APK，调用已转换到`ExternalSyntheticBackport`和旧版集合实现 | 不能只看源码方法的引入版本就断言必然崩溃；也不能据这一项断言全应用兼容API24 |
| ABI | 当前APK没有自带`.so`，生成配置没有主动限制ABI | 目前运行证据仍以x86_64模拟器为主；系统WebView与系统库有自己的ABI要求 | 无自带native库不等于ARM64／32位已实测；后续插件可能改变范围 |
| 本地数据 | 原生事务、同ID重放、强停恢复已有虚构记录证据 | 正式消费写入、日期／预约保护、历史、迁移与磁盘失败尚未设计完整 | 固定123分不能当正式账本或同步写入接口 |
| 在线调用 | 普通POST、受控SSE、TLS连接取消／超时、总时限与错误证书已有证据 | 测试地址仅是本地虚构对端；真实供应商、TCP SYN／DNS、VPN和切网仍有缺口 | 不保证任意网络阶段可即时取消，也不保证供应商支持事件续传 |
| 凭据 | 平台Keystore＋AES-GCM虚构值保存、重读和损坏报错已验证 | 正式输入、失效、硬件背书、卸载与设备迁移策略待评审 | 模拟器与编译进实验的公开token不是完整安全方案 |

[Capacitor Android说明](https://capacitorjs.com/docs/android)给出框架层门槛；以固定依赖源码`Bridge.java`、`CapConfig.java`和生成的`variables.gradle`核对，不能把网页上的最新框架说明当成本仓库已升级。工具链要求见[Capacitor8升级说明](https://capacitorjs.com/docs/updating/8-0)。

当前样式的`@layer`在Chromium99引入，见[Chrome官方说明](https://developer.chrome.com/blog/new-in-chrome-99/)；旧内核会忽略这个规则块。`crypto.randomUUID`还有安全上下文要求，见[API说明](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)。这些是**待验证的功能交集**，不是把正式最低WebView直接定成99：其他语法、提供方实现、样式状态与Android版本仍需实测。`color-mix`和独立`scale`缺失应单列为增强效果差异，不能与基本数据能力混成一个版本号。

原生API检查依据为[Android Set API](https://developer.android.com/reference/java/util/Set)和[D8／desugaring说明](https://developer.android.com/studio/write/java8-support)，本轮DEX检查确认了特定调用的转换。源码lint分析发现的debug域缺少`includeSubdomains`已显式设为`false`，不扩大测试CA或明文例外；完整debug lint加入CI，不能只靠release的vital检查覆盖debug资源。

## 实质取舍

| 路线 | 当前可以复用 | 必须承担的成本／未知 | 本轮判断 |
| --- | --- | --- | --- |
| Capacitor＋Android适配 | TS只读领域、共享语义token与组件状态；已有独立构建和原生机制探针 | 需要独立移动入口、实际业务执行层与可靠存储；自行维护桥接与生命周期；同时验证OS和WebView。现有Next服务器路由／SSR／Python不能直接装入APK | 继续作为主候选补旧系统组合证据；不据原型正式定型 |
| 原生Android UI（如Kotlin／Compose） | 数据契约、参考样例、业务语义和Android平台机制；样式语义可映射 | Web组件和TS界面不能原样复用；领域实现若换语言须重新过同一契约样例；完整业务执行仍需移植。尚无本仓库对照原型 | 若可更新WebView仍出现不可接受的兼容／生命周期障碍，或用户要求无法更新的旧内核也必须支持，再做同场景对照，不先全量重写 |

[Compose官方入口](https://developer.android.com/compose)说明的是原生UI工具，并不自动解决TravelFlow业务迁移或数据协议。以上成本比较是基于当前代码边界的工程判断，未测工期、性能或正式包体积，不将原生路线写成已验证更优。PWA／电脑网页入口继续保留在原仓库，但不据现有网页访问证明Android独立离线、文件与安全存储目标已满足。

## 验证顺序与收口条件

1. **先固定引擎、改变OS。** 本轮API35与API30均使用WebView124；API30自带83的能力不足已复现，更新后再跑存储与网络路径。API26/default镜像允许的Chrome／Google提供方与自带`com.android.webview`不匹配，创建WebView前即失败，因此保留为环境阻塞；未改系统白名单来制造通过。更新仅限自己的隔离模拟器，不操作真机或宿主全局配置，不把过时测试内核推荐给真实用户。
2. **再补系统／引擎边界。** API24仍为候选声明的待核对下界，不因API26通过就删除；需要合法可复现的适配引擎。另补中间系统、较新系统与ARM64真机。若旧内核缺少当前资源所需能力，比较构建时转译／样式适配与明确提示的成本，再决定正式版本政策；不直接删除有来源的设计快照或降低网络安全校验。
3. **每一组都走有副作用的实际路径。** 本地保存／同ID重放、断网强停冷启动、HTTP／SSE、HTTPS证书拒绝、TLS连接／读取取消和超时、凭据保存／重读／失败。原有金额不得归零，失败不能显示成功。功能检测脚本只记录当前WebView能力，不替代这一步。
4. **形成用户可决定的支持提案。** 分别列出已构建、模拟器通过、真机通过和未验证的组合；用户确认目标与剩余风险后才记录框架决定和拟支持范围。正式支持声明与发布还需权限、文件、后台／省电、升级、存储失败和完整旅程验收，不能提前把P4／P5写成完成。

本次评审不启动P1大面积迁移、不修改同步契约。独立连接与完整业务执行仍按跨仓计划分工推进；需要电脑配合时先给带版本的接口差异与联合验收条件。
