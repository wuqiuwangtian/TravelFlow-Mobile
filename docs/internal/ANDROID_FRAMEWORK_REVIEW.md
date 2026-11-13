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
| 在线调用 | 普通POST、受控SSE、TLS连接取消／超时、总时限与错误证书已有证据 | 测试地址仅是本地虚构对端；API24／35原实现受控SYN取消通过，DNS取消与硬总时限未满足；可选客户端已补平台／MiniDNS报文兼容层，旧系统生产解析、代理适配与网络变化未完成；真实供应商、VPN及真机切网仍有缺口 | 不保证任意网络阶段可即时取消，也不保证供应商支持事件续传 |
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

2026-11-12的受控实验已证明：API24／35上`HttpURLConnection.disconnect()`能中断本次SYN等待，但不能让正在挂起的系统DNS立即结束；6000ms总时限只设置停止原因，工作线程仍须等待解析返回。已有实验保留“线程退出后才发单终态”，不会为缩短表面时间提前宣布关闭。后续可选客户端对照已补机制证据，仍须完成旧系统通用解析及正式传输集成，不能直接把当前ProbeStream升格为正式适配器，也不能只换一个带cancel方法的库便宣布解决。

[Android DnsResolver](https://developer.android.com/reference/android/net/DnsResolver)从API29提供带CancellationSignal的异步查询，可作为新系统候选；API24／26需要另评估兼容方案。API存在不等于已经与HTTP／TLS正确集成：仍须保留域名、SNI及证书验证、网络选择和代理语义，并用同一受控DNS场景证明取消后资源回收与单终态。不能仅把业务URL改成IP来绕过原问题。此后已新增显式可选debug对照，见下文；尚未正式改变传输依赖或最低版本，也未让用户接受DNS阶段延迟作为降级。

可选debug对照固定[OkHttp5.3.2](https://github.com/square/okhttp/tree/parent-5.3.2)，用其Dns接口注入解析结果，保留域名URL、默认TLS及主机名校验。固定版本默认Dns源码仍使用阻塞式InetAddress，实际对照同样失败；因此不是“换库即可取消”。新API35平台分支约2ms、旧API24固定UDP分支约5ms结束DNS取消，两者6000ms总时限均能结束请求，释放对端前还能完成新HTTP；域名Host／SNI与错误证书拒绝已实测。默认候选和release未增加该客户端，具体资源、包策略和回归见PROJECT_STATUS。

后续已将API24固定报文实验替换为MiniDNS core兼容层。以下是固定版本的候选比较，不声称这些版本是最新，也没有正式采纳依赖：

| 候选 | 依据与代价 | 本轮结论 |
| --- | --- | --- |
| [MiniDNS 1.1.1](https://github.com/MiniDNS/minidns/tree/1.1.1) core＋自有I/O | 成熟报文解析处理压缩名与记录，三许可可选Apache-2.0；只加core，不引入其递归／迭代客户端；应用仍负责网络绑定、取消、预算及缓存等系统语义 | 仅可选debug使用；JVM协议与API24组合已有证据，维护责任仍需评审 |
| 同版MiniDNS async | [取消路径](https://github.com/MiniDNS/minidns/blob/1.1.1/minidns-async/src/main/java/org/minidns/source/async/AsyncDnsRequest.java)显式取消SelectionKey并通知数据源；该路径未显式关闭通道 | 源码不足以证明符合“取消后立即释放I/O”，本轮未做该客户端的Android行为验收；没有把Future.cancel当完成证据 |
| [dnsjava 3.6.3](https://github.com/dnsjava/dnsjava/tree/v3.6.3) | BSD-3-Clause；SimpleResolver使用Duration／CompletionStage及NIO，需核对旧Android脱糖、附加依赖和取消传播；不能仅因sendAsync返回Future便推定关闭 | 本轮源码对比，未集成／实测；没有据此宣称旧Android不兼容 |

本次旧分支支持CNAME、A／AAAA解码、UDP截断转TCP及显式套接字关闭；API24验证域名HTTPS身份、TCP取消和硬时限，API35平台分支回归通过。每次请求选择当前Network，DNS服务器和HTTP套接字绑定同一网络；此后已补两组蜂窝虚拟网络丢失／重建与监听清理，详见PROJECT_STATUS；并存网络切换／VPN仍未证明。仅可选debug增加网络状态权限；代理和活动Private DNS明确拒绝，代理拒绝／完整恢复已实测，Private DNS未实测。这些拒绝是实验边界，不能直接当正式产品的降级政策。

2026-11-13又补共享期限与服务器回退：旧兼容层使用请求创建时的同一绝对截止时间，UDP转TCP、换服务器、A／AAAA及CNAME均不重置。非末台每次最多1000ms且不超过剩余时间的均分份额，末台使用剩余量；SERVFAIL／REFUSED可换下一台，NXDOMAIN立即失败。响应码含义依据[RFC1035 §4.1.1](https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.1)，整体工作应受限见[§7.2](https://datatracker.ietf.org/doc/html/rfc1035#section-7.2)；1000ms是本项目实验取值，并非RFC要求或正式产品策略。主机26项真实回环I/O与API24固定双对端域名HTTPS、API35平台分支回归通过。实验两服务器同IP不同端口，不是实际多DNS地址／公网环境；正常auto仍读取当前Network的DNS列表，平台分支继续由系统解析。

**尚不足以采用为正式适配器。** 缓存、搜索域、A／AAAA预算份额及部分成功、真实IPv6路由、代理／Private DNS、VPN与网络变化仍有缺口；减少报文实现不等于免除维护系统解析语义。现有证据并不要求更换UI框架，DNS取消是原生传输／解析层的问题。下一项完成上述兼容语义的维护归属提案与必要验证，再交用户确认正式维护成本、框架与支持范围；默认ProbeStream的阻塞DNS缺口保持原记录。

### 旧系统解析兼容语义与维护归属（待评审）

P0网络丢失实验已补“绑定Network消失→真正结束旧请求→离线保存→新Network上的显式新请求”，不自动重发；新系统一次恢复首请求失败尚未定因；此后已有只读定向复现、分阶段／平台DNS数值诊断及HTTP503保留负例，15次正常尝试未再复现，不能据此宣布修复。保留为待证据，复发再定位，不增加盲目重试或无界重复同一实验。接下来将剩余问题收口为可估计维护成本的方案，不把P0无限扩成完整自研解析器：

| 语义 | 当前限制 | 拟验证／评审的边界 |
| --- | --- | --- |
| 网络生命周期 | 请求快照绑定及实际丢失已有证据；重建Network不复用旧标识 | 同时存在多个网络、旧网仍存续、VPN及代理改变需分开验证；Network存在不等于对端可达 |
| 缓存 | 旧兼容层无缓存；平台分支FLAG_EMPTY未主动禁用系统缓存 | 建议P0不增应用DNS缓存；若后续选择自行维护，需按Network／名称／类型隔离并处理CNAME TTL、并发与失效。不存在和解析失败分开，依据[RFC2308](https://datatracker.ietf.org/doc/html/rfc2308)及更新它的[RFC9520](https://datatracker.ietf.org/doc/html/rfc9520)评审；不能把超时记成NXDOMAIN |
| 搜索域／主机名 | 当前仅固定完整实验域名，无搜索域扩展 | 明确正式供应商URL与自定义短主机名需求；不能未经确认丢掉短名称，也不能擅自扩展鉴权请求目标 |
| 服务器与总预算 | 旧分支已共享请求绝对期限与有界服务器切片；丢包、TCP停顿、SERVFAIL／REFUSED的备用接手已测；A后AAAA仍顺序，无类型保底或部分A返回 | 尚需评审类型公平性／部分成功、真实不同DNS地址及网络条件；缓存等不能重置期限。实验仅同次DNS查询切换服务器，没有HTTP自动重发，阈值未成为产品策略 |
| 代理／Private DNS | 实验明确拒绝；尚未实现兼容，Private DNS拒绝未实测 | 优先保留系统配置及域名TLS身份；评估成熟客户端代理路径与旧系统加密解析的维护成本，不默认绕过、硬编码公共DNS或删除目标能力 |

正式采纳前需说明上表哪些由平台承担、哪些由项目维护及如何验收；P0证据支持继续评审Capacitor＋原生传输候选，不等于正式采用MiniDNS兼容层，也不要求先改变UI框架。凭据提案仍需独立确认。

### 维护责任、已确认地址范围与辅助进程对照（2026-11-13）

本轮核对固定OkHttp Android5.3.2发布的[源码Jar](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp-android/5.3.2/okhttp-android-5.3.2-sources.jar)、AOSP [android-15.0.0_r1 DnsResolver](https://android.googlesource.com/platform/packages/modules/Connectivity/+/refs/tags/android-15.0.0_r1/framework/src/android/net/DnsResolver.java)与[Network](https://android.googlesource.com/platform/packages/modules/Connectivity/+/refs/tags/android-15.0.0_r1/framework/src/android/net/Network.java)，没有把最新网页新增的HTTPS记录查询接口混入当前API35实现，也未升级依赖。源码核对是接口／维护归属证据，不是新的Android行为验收。

| 需要承担的语义 | 平台可提供什么 | 项目仍须负责什么 |
| --- | --- | --- |
| 查询与取消 | API29+ DnsResolver提供Network、CancellationSignal与查询标志；既有平台取消实验有效 | 同一请求期限、真实资源回收、单终态、迟到回调及网络生命周期；API24–28没有因此获得这个API |
| 双栈结果 | 固定API35源码按网络能力发A／AAAA，收齐所发查询后汇总并排序；有有效地址时可保留另一查询失败下的结果 | 外层截止先到仍会取消整体；不能说首个A到达即返回，也不能将此行为移植结论套到旧兼容层 |
| 缓存／搜索域 | FLAG_EMPTY未设置NO_CACHE_LOOKUP／STORE；Network.getAllByName是绑定指定网络的系统地址解析 | DnsResolver.query是指定名称的DNS查询，不能等同完整getaddrinfo或宣称已继承搜索域／hosts／DNS64；自有UDP／TCP还需维护正负TTL、类型与Network隔离、搜索顺序等 |
| 代理路由 | 固定OkHttp默认可用ProxySelector；HTTP代理时路由解析代理主机，SOCKS路径可保留未解析目标 | 当前探针明确拒绝代理；仅移除拒绝不等于支持。须验证代理主机解析、CONNECT、原目标TLS身份、取消、407及失败时无意外直连；PAC与代理认证单列 |
| Private DNS | [LinkProperties官方约束](https://developer.android.com/reference/android/net/LinkProperties#getPrivateDnsServerName())要求自定义解析器遵从严格／机会加密模式，系统解析承担相应处理 | 旧层直连LinkProperties的UDP／TCP53不等于遵从加密DNS；当前只证明代理拒绝，Private DNS仍未实测。平台分支也未获完整行为背书，不能直接删除保护或硬编码DoH供应商 |

工程判断：**优先复用系统地址解析，再验证旧系统如何真正结束挂起工作；暂不继续补应用缓存或搜索域。** 依据是当前核心缺口已从报文编解码转到平台语义，继续补功能会使项目长期维护一个解析客户端。该建议不据此排除自定义地址，也不提高最低Android；用户在理解收益与风险后已确认“预设服务商＋高级自定义地址”，优先完整域名与局域网地址，凭据按目标服务隔离、默认HTTPS；短名称／搜索域、内网HTTP、自定义CA继续单独评审。该产品范围尚未实现，不等于正式采纳传输／凭据架构。

自定义服务地址的含义是按用户配置选择在线服务的目标URL，不是输入任意DNS服务器，也不是替用户建立公网中转。该范围已获用户确认，正式交互尚未设计／实现；保留预设服务商入口与高级自定义配置，凭据按目标服务隔离。完整域名（例如`https://api.example.net/v1`）、局域网IP（例如`https://192.168.1.20:8443/v1`）、短名称（例如`https://llm:8443/v1`）须分开：前两者仍需可达性、证书与协议验收，短名称另涉及搜索域及原名称的TLS身份，不能只把字符串变成URL就算支持。

收益是手机可独立切换兼容供应商、自建服务或局域网模型；用户选局域网服务时该服务须可达，但不把电脑在线变成其他手机功能的前提。代价包括目标服务可能接收请求内容及其对应凭据、地址误填或重定向导致的凭据错误发送、证书／内网可达性失败、同名兼容接口的流式与错误行为差异。拟在正式实现前评审目标确认、按目标绑定凭据、默认HTTPS且不以忽略证书解决局域网接入、明确错误与保留本地数据；目标隔离、默认HTTPS与明确失败方向已确认，具体凭据生命周期／交互仍待评审，不能冒充已有安全能力。代理、Private DNS与服务地址是不同配置，不自动替用户互换。

| 旧系统候选路线 | 已有证据／潜在收益 | 额外维护与进入条件 |
| --- | --- | --- |
| 保留MiniDNS core＋自有I/O | API24取消、总期限、多服务器、CNAME与TLS已有证据 | 项目继续维护缓存／搜索域／双栈合并、排序、加密DNS等；这些成本未被一份core依赖覆盖，不能用当前固定对端验证替代 |
| 系统地址解析放在本包私有辅助进程 | Network.getAllByName可将地址解析交给该Network的系统路径；辅助进程结束可能释放应用自己的阻塞工作 | 已有可选debug与API24固定对端证据，详见下文；新增Binder／服务生命周期、进程死亡与迟到结果处理责任。系统共享DNS服务仍可继续；正式语义与网络变化未全部验证，尚未替换默认或正式架构 |

[Android进程文档](https://developer.android.com/guide/components/processes-and-threads)允许为本包组件指定进程；[Process.killProcess](https://developer.android.com/reference/android/os/Process#killProcess(int))受UID权限约束。这只是第二条路线可调查的机制依据，不证明取消、时限或低开销已经满足。这里的“私有辅助进程”与主应用同UID，不是isolatedProcess安全沙箱；不在那里初始化账本、凭据或HTTP，不为结束DNS强停主应用，不将终止其他应用作为方案。

已按以下条件实现显式可选debug机制对照：保留现有客户端，在固定虚构域名与明确专用API24 AVD中验证同Network系统解析。原验收条件为：

1. 确认真实DNS查询正在挂起后，取消及6000ms期限均使本次辅助工作／进程实际结束，解绑与监听释放后才发一个终态；主应用PID和账本快照不变。不能只看Future、Binder确认或stopService返回，也不宣称系统共享DNS服务被停止。
2. 下一次显式新ID可启动新工作并完成原域HTTPS、Host／SNI、公开虚构授权及错误证书拒绝；不自动重试旧HTTP。覆盖绑定期间立即取消、迟到连接／结果和意外进程死亡，避免误杀新工作或自动重启循环。
3. 辅助服务不导出，只进入该可选debug；默认emulator／usb与release的实际APK不含它，不新增权限／业务／共享契约；API35既有平台分支保持独立回归。不得操作手机、其他ADB设备或宿主网络。

本轮API24机制组14项通过：原域HTTPS、DNS挂起取消与6000ms总期限、仅意外终止已核对UID／名称的辅助进程、三个终止条件后的显式新请求、固定400ms绑定延迟中的取消、三次立即取消及三类错误证书。调用方先解绑，再由辅助进程结束自身，只在对应Binder死亡后减绑定计数；普通断连／重连不能代替死亡证据或触发旧请求重试。主进程PID与完整账本不变，结束无辅助进程／晚到事件；实际APK的非导出／独立进程属性已按XML树检查。取消后约156ms检查到结束、总期限终态6034ms（调度与退出仍有开销，不是硬实时上限），绑定延迟取消约461ms；这些是正确性验收时钟，不是性能调查。构建、默认分支回归及一次未定因ADB读取失败均分列于PROJECT_STATUS，不能用后续通过抹掉首次失败。

该实验说明可以用本包进程生命周期替代自有报文I/O作为旧系统候选，但未证明完整系统缓存／搜索域／双栈策略、该路径网络丢失、严格Private DNS、代理／VPN、后台／省电或所有Binder竞态；没有宣称系统共享DNS服务停止。下一项有界验证辅助工作在实际网络丢失时的退出／解绑／新网络新请求，并评审Private DNS拒绝与恢复的可控验收条件，再整理维护路线、正式凭据及框架／支持范围的采纳提案。若出现不能真实退出或不受控重启，回到候选表评审，不以提前终态掩盖。性能调查继续暂缓，正式采纳与支持范围仍交用户确认。

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
2. **再补系统／引擎边界。** API24仍为候选声明的待核对下界，不因API26通过就删除；Google镜像的Chrome69已进入启动保护；API33官方109组件minSdk29且依赖Trichrome，不能用于API24／26。用户已授权第三方原版APK，仅用于隔离模拟器；已从第三方来源取得Chrome119 x86，核验与官方同包签名一致，API24／26在官方32位镜像完整原型路径通过；既有64位API26加载该32位库失败，不能据安装／提供方选中宣布可用。API33／官方109组合已补存储、网络、凭据与断网冷启动证据（见PROJECT_STATUS），尚非固定引擎对照；API36／WebView133模拟器已补网络与本地路径，单台ARM64真机已补本地、USB虚构HTTP／TLS与凭据冷读，映射缺失时仍可保存；旧系统64位引擎已补两组，后续完成旧系统生产解析及网络变化、代理／Private DNS等边界，评审正式凭据策略；公网及真机切网仍未验；上述组合不是所有Android7／8设备支持声明。若旧内核缺少当前资源所需能力，比较构建时转译／样式适配与明确提示的成本，再决定正式版本政策；不直接删除有来源的设计快照或降低网络安全校验。
3. **每一组都走有副作用的实际路径。** 本地保存／同ID重放、断网强停冷启动、HTTP／SSE、HTTPS证书拒绝、TLS连接／读取取消和超时、凭据保存／重读／失败。原有金额不得归零，失败不能显示成功。功能检测脚本只记录当前WebView能力，不替代这一步。
4. **形成用户可决定的支持提案。** 分别列出已构建、模拟器通过、真机通过和未验证的组合；用户确认目标与剩余风险后才记录框架决定和拟支持范围。正式支持声明与发布还需权限、文件、后台／省电、升级、存储失败和完整旅程验收，不能提前把P4／P5写成完成。

本次评审不启动P1大面积迁移、不修改同步契约。独立连接与完整业务执行仍按跨仓计划分工推进；需要电脑配合时先给带版本的接口差异与联合验收条件。
