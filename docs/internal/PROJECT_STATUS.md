# 移动端项目现状

2026-11-05：从TravelFlow-AI迁出P0实验，源码来源974743f；契约来源见vendor/contracts/ORIGIN.json，设计来源见vendor/design/ORIGIN.json。迁出时Capacitor仍为候选；用户2026-11-14已确认固定8.6.0主线及TS／Android分层，进入P1设计。正式Android应用、完整账本和同步均未实现。版本0.0.0仅标识开发仓库，不是产品发布。

## 能力与证据

迁移前原型在WSL2/KVM的Android15（API35、default x86_64、WebView124.0.6367.219）验证：原生SQLite保存123分、同ID重放不增加；飞行模式下强停重开仍保留，可追加到246分；再次强停保持；原生HTTP虚构服务POST200，服务／网络失败后仍可追加至369分。只读导出的虚构SQLite副本核对3条／369分／3个唯一ID。历史证据归属桌面提交974743f，不能冒充迁移后重新跑过。

迁移后首次验证已完成：新仓库独立冻结安装、快照来源／摘要检查、14组账目对照、非法输入防护、TS类型检查、脚本语法与Python编译通过；篡改快照与浮动Git版本被拒绝，npm审计零已知漏洞。独立生成路径包含空格的工程，复用隔离SDK缓存离线执行`:app:assembleDebug`通过（JDK21、SDK36、Build Tools35.0.0）。新APK全部assets与迁移前逐字节一致，两个Java源码也保持一致；首次迁移检查未重新运行模拟器交互，不将历史运行证据写成重新验证。生成工程在`/tmp/travelflow mobile standalone p0/`，不进入Git。初始提交8443cd0的远端CI通过（含独立APK构建）。vendor快照固定LF，另在core.autocrlf=true的检出副本验证摘要保持；这不是Windows原生APK构建或真机验收。e7d77a1的远端CI也已通过；当时只补接续文档，未重跑APK／模拟器。最新CI仍按提交核对，未正式发布。当前构建与检查入口见MAINTAINING，当前下一项见PRODUCT_ROADMAP。 SDK及生成工程均在仓库外；不读取个人旅行、配置或真实供应商。

## 未覆盖

已有单台ARM64真机的本地存储、USB本地HTTP／TLS、公开虚构凭据及强停冷读证据；公网、切网及最低系统／WebView边界仍未确定；存储不足、升级迁移、正式凭据生命周期／硬件安全背书、公网供应商HTTPS／鉴权、SYN取消仅补两台专用模拟器，原ProbeStream的DNS真正取消及硬总时限尚未满足；可选新客户端已补平台分支与MiniDNS报文兼容层对照，但生产解析、代理适配与切网尚未完成，真实供应商流式／续传仍未覆盖。没有正式签名或发布。下述模拟器和固定本地服务证据不能推广为上述能力已通过。桌面端Windows／WSL启动和网络连接原型由原仓库负责，移动构建不导入桌面源码。跨端契约目前只有只读账目投影0.1.0，不是完整数据或同步契约。

## 2026-11-06：P0原生流式适配实验

本次新增`ProbeStreamPlugin.java`、页面实验入口、可观察断连的分块虚构服务及`scripts/check-android-stream.mjs`。沿用固定Capacitor8.6.0，不增加依赖；Android自带`HttpURLConnection`在工作线程读取UTF-8／SSE，在独立关闭线程取消。探针只允许固定测试地址与模式，不接收真实凭据／业务数据，不改变领域契约或SQLite实验语义。原生工作线程关闭连接后才发终态，取消方法本身的确认不冒充请求已经结束。

在WSL2/KVM、隔离AVD`travelflow_p0_api35`／`emulator-5580`（Android15、API35、x86_64、WebView124.0.6367.219）实际安装新debug APK并验证：

- 正常分块在约0.11–0.52秒首次交付、约2.72秒完成，三个中文事件完整且有中间交付；服务故意在中文UTF-8字节中间分片。相同服务的内置CapacitorHttp约2.73–2.75秒整包返回，与固定源码的缓冲行为一致。
- 停顿在首块之后，取消后约34–42毫秒检查到原生终态（含并发本地写入和CDP检查）；服务端约0.56秒（从请求开始计）观察到`peer_closed`，早于读取超时，无后续事件。另有3次请求开始后立即取消，通过单终态检查；并发请求和错误请求ID取消被明确拒绝。
- 读取停顿产生`TIMEOUT`，请求约1.62–2.02秒终止（1500毫秒是等待后续数据的读取超时，不是请求总时限）；截断响应明确失败；HTTP503明确失败。断开后携带`Last-Event-ID: 1`显式重连，只交付第2、3块。该恢复仅基于虚构服务可重放事件，编号仅保存在当前页面内存，不代表任意供应商或重启后可恢复。
- CDP的`Input.dispatchTouchEvent`实际操作分块、停顿超时、取消、中断和恢复按钮通过；没有用桌面浏览器替代原生运行。
- 不清空历史虚构库：起始369分，取消期间新增／重放后492分；扩展验收再新增至615分。飞行模式下强停冷启动保留615分、失败后本地新增／重放至738分；恢复网络但停止测试服务，失败后仍新增／重放至861分。恢复服务、再次强停重开保留861分，普通POST与流式完成均通过。

本地快照校验、14组账目对照与非法输入防护、TS类型检查及新增JS／Python脚本语法检查通过；全新生成工程`/tmp/travelflow-mobile-stream-p0/`使用既有隔离JDK21／SDK36／Build Tools35.0.0／Gradle缓存离线`:app:assembleDebug`通过。自动运行输出在`/tmp/travelflow-mobile-stream-{evidence,offline,service-down,recovered}.json`，仅含虚构实验数据，不进入Git，也不是接手续跑的前提；可复现步骤在MAINTAINING。CI增加脚本语法检查，仍只构建APK，不运行模拟器；本次远端CI状态按实际提交另行核对。

该阶段结论：在该环境中，为Capacitor候选补一个不新增依赖的原生流式探针可行。未正式选定框架；当时待补的HTTPS、凭据与连接阶段实验见下节，兼容性和真实服务仍需独立证据，P0未结束。

## P0 HTTPS、虚构凭据与连接阶段增补

沿用上述API35／x86_64／WebView124隔离模拟器，实际安装两份新debug APK：不注入测试CA的默认工程，以及仅debug注入短期测试CA的工程。新增`ProbeCredentials.java`、TLS证书生成／Android验收／APK策略检查脚本；服务扩展为有效、非信任、主机名不匹配、过期证书及握手停顿五类端口。传输仍使用Android自带实现，无新增运行时依赖；只访问本地虚构服务，不读真实密钥、旅行或供应商配置。

- 默认系统信任拒绝测试CA。debug显式信任该CA后，有效HTTPS成功，三种错误证书均`TLS_FAILED`且服务端没有收到HTTP请求；没有绕过主机名或证书验证。
- AndroidKeyStore生成AES密钥，固定公开虚构token的AES-GCM密文／IV写入专用prefs，JS桥不接收／返回token，账本不存凭据。强停冷启动、不重新准备凭据仍可调用HTTPS；移除凭据后`CREDENTIAL_UNAVAILABLE`且不发请求。缺少／错误授权返回401；307重定向被拒绝，目标端无请求。虚构值编译进实验不代表真实密钥可硬编码。
- 在隔离模拟器强停后，仅修改该专用prefs中密文的一位（保留合法XML和IV），重启明确报`CREDENTIAL_UNAVAILABLE`，没有静默清除密文或改账本。还原实验备份后再次冷启动，HTTPS恢复。专用暂存文件已移除；不是对真实用户数据的恢复或迁移验收。
- 服务收到TLS ClientHello但不回复时，取消后约38–46毫秒检查到原生终态（含本地写入与CDP检查），服务端约79–103毫秒观察到连接关闭；不取消约1.52秒报`CONNECT_TIMEOUT`。这是TCP已连通的TLS连接阶段证据，不是SYN黑洞或DNS证据。
- 连续分块间隔约500毫秒，读取超时不触发；2500毫秒总时限在约2.51秒产生`DEADLINE`并关闭连接。其他模式总时限6000毫秒；这些是实验阈值，非正式产品策略。
- 新增按钮通过CDP实际触摸，传输选择器由脚本设值。原HTTP流式／取消验收回归通过。虚构账本从861分开始，TLS取消期间新增／重放至984分、HTTP回归至1107分、最终TLS验收至1230分；冷启动与密文损坏／还原均保留10条／1230分。私有prefs、只读SQLite副本、该应用PID的logcat与桥事件检查未发现虚构token明文；这不是完整安全审计或真实密钥保护验收。

本地独立debug构建通过；unsigned release首次离线构建因未缓存的Kotlin lint依赖失败，联网下载后debug／unsigned release构建均通过，未跳过lint。对实际APK资源检查：debug含一个公开测试CA且仅测试域允许明文，release不含测试CA、只信任系统CA、拒绝明文；两者禁用备份且没有私钥。向unsigned release副本故意追加测试CA后，检查器拒绝；TLS摘要篡改在生成前被拒绝。CI新增同样的证书生成、debug／unsigned release构建和打包策略检查，不发布、不签署正式安装包，也不运行模拟器。共享契约、领域和设计快照未改；最终本地检查与远端CI按提交核对。

可复现入口见MAINTAINING。实验工程为`/tmp/travelflow-mobile-tls-{system,trusted}/`，最终生成器另在含空格的新路径`/tmp/travelflow mobile tls final/`生成成功；后者与已构建工程的应用源码／资源逐项核对。证书与私钥仅在仓库外`/tmp/travelflow-p0-tls-fixtures/`，有效期2天；运行证据为`/tmp/travelflow-mobile-tls-*.json`，不提交且不作为续跑前提。AndroidKeyStore硬件背书、密钥失效／卸载／跨设备恢复、正式输入与同步政策仍未确定。P0下一项为候选框架及兼容性评审，不能根据单一模拟器自动定型。


## P0框架评审与旧系统／可更新WebView对照

已形成[框架与兼容性评审稿](ANDROID_FRAMEWORK_REVIEW.md)，只读核对固定版本源码、APK和电脑仓库固定提交的能力矩阵；未导入电脑代码或升级快照。用户明确优先验证旧Android＋可更新WebView，旧内核仍保留评估项。建议继续以Capacitor为主候选，不代表正式框架或最低范围已确认。

| 系统／提供方组合 | 已验证结果 | 证据边界 |
| --- | --- | --- |
| Android15 API35／WebView124／x86_64 AVD | 最终构建的能力诊断、真实触摸与TLS全套回归通过 | 保留原模拟器历史虚构库，最终12条／1476分；未重跑此前全部离线历史验收 |
| Android11 API30／自带WebView83／x86_64 AVD | 诊断实测缺少`randomUUID`与`cssLayers`，旧构建曾停在初始化；最终经典启动脚本明确提示更新、全部按钮禁用、未加载应用模块 | 验证的是当前构建不满足所需能力；不是宣布所有旧内核不支持。已有123分的SQLite在提示前后逐字节一致 |
| 同一API30 AVD／更新为WebView124 | 最终构建能力检测、TLS与凭据／401／307／错误证书／握手取消及超时／总时限、HTTP流式／恢复／重放、断网强停冷启动和恢复网络后凭据冷读均通过 | 4条／492分为该独立AVD的虚构库，不是跨端同步；不是ARM64或Android7／8证据 |
| Android7／8 API24／26 Google APIs／Chrome119／x86 | 两组存储、HTTP／TLS、断网冷启动与凭据冷读通过 | 详见旧系统32位组合章节；API24本轮点击驱动回归后4条／492分，API26仍3条／369分 |
| Android7 API24／Android8 API26 Google APIs／Chrome119／x86_64 | 同一双ABI分包及同一APK的64位进程路径、完整HTTP／TLS、飞行模式冷启动与凭据冷读通过 | 各3条／369分；API24的空dumpsys仍保留未知，实际页面／进程／存储单独核对；见2026-11-12增补 |
| Android13 API33 Google APIs／WebView109／x86_64 | 存储、HTTP／TLS、断网冷启动与凭据冷读通过 | 3条／369分；此组合未逐项重做API35全部历史边界 |
| Android16 API36 Google APIs／WebView133／x86_64 | 同类网络／凭据及本地触摸／强停恢复通过 | 后续USB配置验收后8条／984分；系统ABI列表含ARM64不能当真机证据 |
| 用户授权ELI-AN00手机／API36／WebView150／ARM64 | 本地保存／重放、USB本地HTTP／TLS、虚构凭据及强停冷读通过 | 4条／492分；映射缺失时仍可本地保存；未切换手机网络，未调用公网供应商 |
| Android8 API26/default revision1／自带58或安装124 | APK安装成功，创建WebView时失败；系统允许的Chrome／Google提供方不含`com.android.webview`，`Current WebView package is null`，日志`MissingWebViewPackageException` | 测试环境阻塞，未修改白名单或重签组件来制造通过；不能据此认定TravelFlow业务不兼容API26 |

API30/default/x86_64 revision11、API26/default/x86_64 revision1均通过官方SDK工具安装在既有隔离缓存，新建专用AVD且不覆盖已有实例。API30使用`travelflow_p0_api30`／`emulator-5582`，API26失败调查后关闭，同一端口随后由明确的API30实例使用；API35仍在5580。WebView124只从已有官方API35镜像提取到仓库外，核对包名、minSdk26及ABI后用于隔离更新，不分发给用户。API26框架配置的提供方列表已从实际`framework-res.apk`核对；仅安装满足minSdk的APK不足以保证系统接受其作为WebView。

本轮改动包括经典`bootstrap.js`启动保护、窄视口控件宽度约束、当前WebView只读诊断、debug域显式`includeSubdomains=false`和APK范围断言。共享设计快照未改。当前构建原样使用模块、顶层await、可选链和现代CSS，不能从框架声明的WebView60推导应用可用，也未将99等源码推测值写成正式最低内核。基线DEX中的`Set.of`调用已由D8改写为兼容实现，没有仅凭API文档判它为必然崩溃。

原生触摸脚本在API30最初因可视视口偏移而点中按钮下方文字；修正为等待绘制、扣除`visualViewport`偏移并检查点击中心可见后，真实触摸全套通过，不以JS `.click()`替代。最终API30布局／内容宽度均122CSS像素（320×640、420dpi的额外窄视口），API35均320，无横向溢出；未作为正式手机交互验收。

API30数据保护过程：先保存／重放固定ID至123分，WebView83的启动提示不改该库；更新124后TLS验收追加至246分，HTTP验收至369分。飞行模式下强停重开保留369分，网络请求明确失败，本地追加／重放后492分；恢复原网络状态后再次强停，`--cold-start`不重新准备凭据，HTTPS完成，仍4条／492分。未清库、未修改原生表结构或领域口径。API35本轮两次TLS回归将既有1230分追加到1353、1476分，均为实验新增，不是正式财务写入。

最终工程`/tmp/travelflow-mobile-compat-reviewed/`冻结生成、debug／unsigned release离线构建及主源码`lintAnalyzeDebug`通过；实际APK范围检查通过，无自带`.so`或私钥，release无测试CA／明文例外。旧debug APK缺少显式子域范围，被新检查器拒绝。主源码lint原有的debug网络配置错误已消除，仍有7条模板图标／manifest等警告。本机完整`lintDebug`因测试依赖未缓存、联网下载JUnit时TLS握手失败而未完成，不把主源码分析当完整lint；CI已增加完整debug lint，结果按实际提交核对。没有为此关闭TLS验证或跳过新的检查。

运行输出为仓库外`/tmp/travelflow-mobile-compat-*.json`，API26错误另有`/tmp/travelflow-mobile-api26-*.txt`；复现不依赖这些临时文件，步骤在MAINTAINING。API24／26的Google镜像与组件调查见下节；新版匹配提供方仍未验证，正式业务、同步与真机范围仍未实现，P0未收口。下一项按评审继续补上述边界，再交用户确认框架与拟支持范围。

## P0旧系统提供方与候选APK核验（2026-11-09）

新增两个只读工具：`inspect-android-provider.py`核对明确隔离模拟器的SDK、启动状态、ABI与当前提供方；`inspect-webview-apk.py`验证APK签名并提取版本、minSdk、ABI、WebView库声明与静态库依赖。二者不安装、不切换提供方，也不写账本；CI加入语法检查。应用功能、共享快照与原有目标未删改。

- 官方Google APIs API26/x86_64 revision16，专用`travelflow_p0_api26_google`：选中合法`com.android.chrome`69.0.3497.100，原型可显示启动保护；实际诊断缺少`randomUUID`、`optionalChaining`、`cssLayers`，尚未进入存储／网络验收。这解决了default镜像的提供方环境故障，没有解决旧内核能力。
- 官方Google APIs API24/x86_64 revision27，专用`travelflow_p0_api24_google`：原型同样在Chrome69显示能力不足。该系统`dumpsys webviewupdate`为空，虽然配置值是`com.android.chrome`，工具仍报告`selectionInspectable=false`、`providerSelected=null`并退出2；配置值不冒充实际选中状态。API26已选中退出0；明确未选中退出1。
- 从官方API33 Google镜像只读提取的Google WebView109.0.5414.123与Chrome109均要求minSdk29，依赖同版本`com.google.android.trichromelibrary`；Chrome这份APK没有WebView库声明。签名校验通过，仅表示APK自身签名有效，不代表已核验发布者身份或可更新旧包。两份候选均未安装到API24／26；不能修改minSdk、重签或改白名单来制造通过。
- 已有官方AOSP WebView124副本minSdk26、声明WebView库且包含x86_64／x86，但包名`com.android.webview`不满足上述Google旧系统提供方策略；minSdk匹配不是完整兼容证明。API26 Google自带Google WebView69文件仅为约400KB stub，也不能作为完整引擎或新版APK的签名身份依据。
- 官方Play Store API24/x86 revision19专用`travelflow_p0_store24`尝试停在ADB授权，未取得新版组件；未登录／创建账号、未接受新增服务条款，已停止该实例。此路径尚未验证，不能据此断言商店无法更新。下一步需选定可复现的旧系统新版组件来源并核验身份，再执行实际副作用路径。

上述系统镜像、AVD及提取APK仅在既有仓库外缓存；不提交或分发。API33来源AVD为`travelflow_p0_provider_source33`，当时仅核验组件；后续原型运行增补见下节。2026-11-09复验使用自己的API26端口5558、API24端口5560；端口会复用，接手必须重新确认AVD归属与SDK，不依赖旧序列号。之前`/tmp`工程与证据已被环境清理，短期证书已过期，后续HTTPS须重新生成证书与工程；历史结论不改写成当前文件仍存在。基线`08b9ade`远端CI完整debug lint与构建已通过；本轮工具／文档CI按对应提交核对。API30／35历史矩阵仍有效，但本轮未重跑。

## P0 Android13／WebView109组合验收（2026-11-09）

应用源码仍为`08b9ade`基线，工具基线为`61ea9d9`；沿用官方API33 Google APIs/x86_64 revision17的专用`travelflow_p0_provider_source33`，实际选中`com.google.android.webview`109.0.5414.123。本轮以空闲5558端口启动该明确AVD；其他ADB设备未安装、切网、强停或清数据。这是一组OS／引擎同时变化的组合证据，不是单变量对照，也不是Android7／8可更新引擎的替代证据。

- 重新生成两天有效的仓库外TLS材料及独立工程，使用既有JDK21／SDK36／Build Tools35.0.0／Gradle缓存，离线`:app:assembleDebug`成功。安装debug后，能力检测与原生桥就绪，布局／内容宽度均412CSS像素，无横向溢出；`colorMix=false`，对应共享组件的悬停阴影增强差异，未修改vendor快照，未获正式交互验收。
- TLS完整脚本通过：有效HTTPS及中文分块、三类错误证书拒绝且未收到HTTP请求、缺少／错误授权401、307不跟随、虚构凭据移除／重建、TLS握手取消／连接超时与持续分块总时限均符合断言。取消后99毫秒检查到原生终态，服务端104毫秒观察到关闭；总时限2502毫秒触发`DEADLINE`。这仍是TCP连接后握手阶段，不是DNS或SYN黑洞证据。
- HTTP完整脚本通过：真实触摸、普通HTTP对照、中文分块、读取取消／超时、立即取消、并发与错误ID拒绝、截断及显式恢复、HTTP503、本地新增与幂等重放。读取取消39毫秒检查到终态，服务端在请求开始后187毫秒观察到关闭。
- 该AVD初始虚构库为空，TLS后1条／123分，HTTP后2条／246分。确认飞行模式原值0后设为1，强停冷启动、更新PID与转发，网络明确报`NETWORK_OR_PROTOCOL`；原246分保留，本地新增／同ID重放后3条／369分。恢复原飞行模式0，再强停冷启动，`--cold-start`不重新准备凭据，HTTPS成功且仍3条／369分。没有清库或改表；不是正式财务或跨端同步。

验收脚本增加冷读前后记录数／金额一致断言，已在该实际Android环境执行通过；不是只核对页面显示。未重复API30／35历史验收；API33未重做默认系统CA对照、密文篡改恢复、服务停止、权限／文件、后台／省电或升级迁移。构建成功、模拟器通过、真实供应商、真机和用户验收仍分别记录。契约、14组账目样例、类型及脚本语法检查通过；应用功能无新增／删除，验收增强及既有文档更新，未新增运行时依赖。

本轮工程`/tmp/travelflow-p0-app-20261109-api33/`、证书`/tmp/travelflow-p0-tls-20261109-api33/`及`/tmp/travelflow-api33-{provider,compat,tls,stream,offline,cold}-20261109.json`均在仓库外，不作为续跑前提。结束后移除本轮转发、停止测试服务与该模拟器，保留AVD虚构记录。复现入口见MAINTAINING的API33小节。P0仍需旧系统新版组件取得及匹配运行、较新系统／ABI与真实设备证据；未正式选定框架或最低范围。

## P0第三方原版组件授权与准入核验（2026-11-09）

用户已明确允许从第三方镜像站取得原版Chrome／WebView APK，先核验官方签名、系统要求与提供方资格，再仅安装到本项目隔离模拟器；无需重复询问来源授权。本轮实际启动专用 `travelflow_p0_api26_google` 于空闲5558，确认SDK26、当前Chrome69后，从官方系统分区提取完整Chrome69作为身份基准。包名、文件／签名SHA256及复现命令见MAINTAINING；基准未提交或分发。

APK检查器增加可选候选准入模式：必须同时提供参考APK、预期包名、必需ABI，双方执行真实签名校验；逐项核对同包签名集合、SDK上下界、ABI、WebView库声明与未解决静态库依赖，不安装或更改设备。实际使用已缓存官方APK验证：Chrome69参考样本元数据通过；同签名Chrome109因minSdk29、缺少WebView库声明及Trichrome依赖被拒绝；AOSP124因包名／签名不符被拒绝；正确签名的69指定ARM64仍被拒绝。对已签名原型APK副本追加ZIP条目后，真实签名校验失败且不输出准入结果；不完整准入参数在处理APK前被拒绝。此准入不证明引擎能力、系统白名单、更新版本码资格或正式兼容，不自动接受签名轮换。

下载调查结果：[APKMirror119 x86＋x86_64候选页面](https://www.apkmirror.com/apk/google-inc/chrome/chrome-119-0-6045-194-release/google-chrome-fast-secure-119-0-6045-194-9-android-apk-download/)可由搜索访问，但实际HTTP及正常浏览器均返回403，未取得APK；APKPure与Softpedia同样403。[Uptodown119样例页面](https://chrome.en.uptodown.com/android/download/116819522)可访问，已检查119系列及117／112／111／109／106部分候选页面，所列均为ARM或ARM＋ARM64，不能用于当前x86 AVD（未下载／安装这些变体）。这些是下载访问与页面元数据证据，不是对第三方APK做完真实性核验。没有改白名单、重签或用不匹配组件制造通过；没有安装任何第三方组件，也未新增账目或改变网络设置。浏览器临时记录已移到仓库外，专用模拟器结束后关闭。

原型应用仍为既有基线，既有目标、领域及共享快照未变；本轮仅增强开发检查与同步现有文档，无新增／删除业务功能。截至该次调查的缺口是可取得的匹配引擎文件，不是用户授权；后续取得与运行结果见下节。`cb147ff`的CI第三次仍在Gradle发行包下载返回HTTP504，尚未进入Android编译；不通过跳过构建或降低TLS验证解决，本轮本地检查和新提交CI分别按实际结果记录。

## P0 Android7／8＋Chrome119的32位组合验收（2026-11-09）

第三方组件获取已打通：从[APK.Gold的119.0.6045.193 x86候选页](https://apk.gold/download?file_id=2753516/chrome)提供的正常下载链接取得191313115字节APK，留在仓库外。实际文件SHA256 `d88b3e77e8aa6c98d07bdad4099caf22d36a495312116549e1fde1aad6ad2f14`，包名 `com.android.chrome`、versionCode604519326、minSdk24／maxSdk28、x86、声明WebView库、无静态库依赖。真实APK签名校验通过，证书SHA256与官方Chrome69基准完全一致（基准值见MAINTAINING）；API24／26准入检查均通过。官网系统镜像中独立提取的API24与API26 Chrome69文件也逐字节相同。未采用站点“安全”标签作为身份依据，未重签、改包或分发文件。

先在既有API26 Google/x86_64专用AVD更新Chrome：系统接受并选中119，但P0实际为`app_process64`，创建WebView失败，日志明确 `libmonochrome.so ... is 32-bit instead of 64-bit`。系统支持ABI列表包含x86，不等于64位应用可加载32位引擎。随后只撤销本次Chrome更新（`pm uninstall -k com.android.chrome`），确认恢复官方Chrome69，未清除P0数据。此失败保留为ABI组合证据，不能写成Android8业务不兼容。

为验证匹配的进程／组件，新建以下官方32位Google APIs隔离AVD，无覆盖或清库。沿用原独立debug APK（`/tmp/travelflow-p0-app-20261109-api33/`，应用源码基线`08b9ade`，本轮脚本基线`c0b4397`，未重新构建／改动APK）；测试CA在本轮仍处于有效期，未向系统安装CA。

| 组合 | 实际提供方／进程证据 | 实际验收结果 |
| --- | --- | --- |
| API24 Google APIs/x86 revision27，`travelflow_p0_api24_google_x86` | APK正常更新；页面UA为Chrome119.0.6045.193，原生桥就绪，实际`/proc/<PID>/exe`为`app_process32`；dumpsys接口仍为空，工具保留未知 | 能力检测、完整TLS脚本、完整HTTP流式脚本、断网强停冷启动、恢复网络后凭据冷读均通过 |
| API26 Google APIs/x86 revision16，`travelflow_p0_api26_google_x86` | dumpsys确认选中`com.android.chrome`119.0.6045.193；页面同版本，实际`app_process32` | 同上，各脚本明确`passed: true` |

TLS覆盖有效HTTPS、三类错误证书拒绝且没有HTTP请求、401／307、不跟随重定向、虚构凭据移除／重建、握手取消／连接超时、持续分块总时限。API24／26握手取消分别19／27毫秒检查到原生终态，服务端均96毫秒观察到断连；连接超时1509／1511毫秒，总时限2502／2505毫秒。HTTP覆盖真实触摸、中文分块、整包对照、读取取消／超时、立即取消、并发／错误ID拒绝、截断及显式恢复、503及本地重放。读取取消分别14／26毫秒检查到终态；服务端在请求开始后116／166毫秒观察到关闭。均非DNS或SYN黑洞证据。

两套新AVD初始虚构库各为空，TLS后1条／123分，HTTP后2条／246分。旧系统的`cmd connectivity`返回`No shell command implementation.`，即使退出0也不能当切网成功；直接发送飞行模式广播亦被系统拒绝。最终通过系统设置页面的实际触摸切换，确认飞行模式原值0→1后强停冷启动，网络报`NETWORK_OR_PROTOCOL`，246分保留，本地新增／同ID重放后各3条／369分。再通过设置UI恢复原值0，强停冷启动，更新PID／转发，`--cold-start`不重新准备凭据仍HTTPS成功，记录数与金额前后均为3／369。没有将设置值、服务停止或页面UA单独冒充断网／运行通过。

页面布局／内容宽度均412CSS像素，所有能力和两项增强效果检测通过；未作正式手机设计验收。本轮只改现有文档，无应用或功能新增／删除，无运行时依赖、领域、契约或设计快照变更。没有重跑API30／33／35历史路径；API24／26未做默认系统CA替换对照、密文篡改恢复、磁盘失败、升级迁移、后台／省电、真实供应商或ARM真机验收。Chrome119仅作历史兼容实验，不是实际设备更新建议。

新AVD本轮分别使用5558（API26）、5560（API24），CDP19238／19239；端口只是本次实例，复现先核对归属、SDK与进程ABI。原型APK、下载APK、官方镜像、虚构库及`/tmp/travelflow-api{24,26}-x86-{provider,compat,tls,stream,offline,cold}.json`不提交，也不作为接续前提。结束后恢复网络、移除本轮转发、停止自己的服务与两台模拟器，保留测试记录和已验证引擎。旧API24／26 x86_64 AVD仍保留Chrome69基线；API26的64位失败日志在仓库外。本轮结果补上“旧Android＋可更新WebView”的两组32位模拟器证据，P0下一项转为较新系统、64位引擎／ARM64真机等剩余边界，再交用户确认框架与拟支持范围。

## P0 API36模拟器与首台ARM64真机本地验收（2026-11-09）

新增官方 `system-images;android-36;google_apis;x86_64` revision7及专用 `travelflow_p0_api36_google`，本轮5558／CDP19238。实际选中Google WebView133.0.6943.137，原型为`app_process64`、内核及提供方为x86_64；`abilist`虽含arm64-v8a，仍只计x86_64模拟器。沿用此前已构建debug APK及本轮仍有效的两天测试CA，未重建／改动应用APK，未向系统安装CA。

本轮发现并复现测试驱动竞态：该环境touchend后约280–300毫秒才出现click，旧驱动已进入下一操作，重复终态文字让等待提前结束，后续滚动导致触摸落到其他按钮；TLS脚本两次停在DEADLINE等待处。记录实际可信touch／click事件后，单独触摸持续分块正常触发DEADLINE。修正仅在CDP测试驱动：发送真实触摸后等待目标按钮的`isTrusted`点击回执，再继续断言；错目标或超时明确失败，finally移除监听器和回执。不使用JS `.click()`、固定补眠或降低原生超时。刻意在捕获阶段阻止点击时，驱动按预期失败、临时状态清理且账目不变。

修正后API36完整TLS、HTTP脚本通过，覆盖真实触摸、正常与错误证书、401／307、虚构凭据失败／恢复、连接与读取取消／超时、总时限、分块／截断／显式恢复、503与本地重放。TLS取消115毫秒检查到原生终态，服务端62毫秒观察到关闭；连接超时1544毫秒、总时限2505毫秒。这些仍不覆盖DNS或SYN黑洞。初始虚构库0，TLS后123分、HTTP后246分；飞行模式原值0→1，强停冷启动，网络失败、本地新增／重放至369分。恢复0、再次冷启动，凭据不重新准备仍可HTTPS，保留3条／369分。

新增 `check-android-local.mjs`：通过实际触摸保存／重放，逐条保护原记录并检查仅新增123分；`--expect-local COUNT CENTS`只读核对持久结果，不改变网络。API36再经此脚本及强停只读验证至4条／492分；API24／Chrome119的已有32位AVD也仅回归此受影响路径，从既有3条／369分追加至4条／492分，重放与强停后保持；未重跑所有旧网络历史验收。能力／增强检测与横向布局检查通过，API36布局与内容均412CSS像素。固定依赖SystemBars在初始化早期有documentElement为空的安全区CSS注入日志；本轮未改依赖，也未将截图／按钮验证推广为横竖屏、键盘或完整安全区验收。

用户随后提供USB手机，并明确批准对已识别设备安装独立P0 APK、仅做启动／本地记录／重放／强停恢复；这构成AGENTS默认仅限模拟器规则的一次明确范围例外，不代表其他真机操作获授权。复用Windows已有ADB服务与Windows Node，只针对该已识别设备操作；未重启或替换用户ADB服务。安装前核对包未安装，核对APK SHA256 `f27e4d10632a705bde56353f1c5f1496ad505a6b200ea7150ea3afd5faaba0ae`，实际仅声明INTERNET及本包内部动态接收器权限。系统元数据查询曾被其他受保护用户空间拒绝，后续启动／强停与包查询明确限定当前用户；未绕过限制。

真机结果：ELI-AN00、Android16／API36、实际Google WebView150.0.7871.181，内核aarch64、应用`app_process64`；能力与原生桥就绪。Windows侧CDP真实触摸后由0到1条／123分，重放整个快照不变；仅强停并重启本包后，`--expect-local 1 123`通过。布局／内容均369CSS像素，无横向溢出；不是完整手机交互验收。没有运行真机联网测试、准备凭据、切换手机网络、升级WebView、访问其他应用数据或抓取手机全屏／日志／数据库；原型APK、1条虚构记录保留，测试结束后仅强停本包、移除本轮转发。

本轮新增一个本地验收脚本、修改CDP触摸驱动及CI语法检查，同步既有文档；无应用／业务功能新增或删除，无运行时依赖、共享契约、设计快照变化。契约、14组账目样例、类型及脚本语法检查通过。原型工程仍在仓库外，API36与真机仅计对应已执行范围；证据为仓库外 `/tmp/travelflow-api36-*.json`、`/tmp/travelflow-api24-*-regression.json`及`/tmp/travelflow-arm64-device-*.json`，不提交手机序列号、个人数据或原始证据。复现见MAINTAINING。本轮仅关闭自己的API36／API24模拟器、服务和转发；其他ADB设备与Windows服务保持原状。

截至该轮，P0下一项是准备USB测试对端并明确真机网络／凭据范围；当时联网入口固定10.0.2.2，仅适用于模拟器，后续配置增补见下节；旧系统64位引擎、TCP／DNS取消和正式凭据策略也仍有缺口。正式框架与支持范围未定，P1未启动。

## P0 USB回环测试配置准备与模拟器验收（2026-11-09）

生成器新增闭合的构建参数 `--target emulator|usb`，默认仍为10.0.2.2，usb为127.0.0.1；不接受任意host／URL。由同一生成变量写入Java的ProbeEndpoint常量、页面endpoint模块及唯一debug域配置，原生ProbeStream仍不从JS桥接收地址。TLS生成器与服务使用相同target，证书SAN、307目标和fixture元数据对应该固定IP；配置混用在生成目录或监听端口前拒绝。旧无host字段的v1 fixture仅按默认模拟器地址处理。release仍只信任系统CA、拒绝明文，不含测试CA；未改账本表、数据语义或运行时依赖。

实际发现标准 `adb reverse tcp:PORT` 在API36上产生通配监听；本轮不将其带到手机。依据[AOSP监听实现](https://android.googlesource.com/platform/packages/modules/adb/+/30e74acef93318b07a2de7ffca5086dde868ad01/socket_spec.cpp)，新增manage-probe-reverse.mjs：向已有本机ADB服务选择明确serial，直接请求标准协议的 `tcp:localhost:18510–18515` 监听，保留设备授权与服务端检查，不改ADB二进制或系统权限、不重启服务。真实模拟器ss核对六端口均为127.0.0.1；adbd列表将名称规范化为tcp:PORT，清理按该名称。工具只处理这六个固定端口；添加不覆盖已有映射，部分失败只回滚本次成功的新建项。协议检查器仅使用本机模拟对端，验证分片响应、设备拒绝、端口约束、已有映射保留及回滚；Linux和Windows Node均通过。真实模拟器保留18512–18515、尝试全量添加时，10／11新建后因12占用失败，回滚后既有四项完全一致。

分别生成独立emulator与usb工程及两天TLS材料，JDK21／SDK36／Build Tools35.0.0。两配置debug／unsigned release构建和完整debug lint均通过；USB首次离线lint因缺少concurrent-futures测试依赖失败，联网补齐后通过，没有关闭检查。实际APK检查解析XML层级，验证页面常量和唯一debug域匹配target、CA仅限该域、显式不含子域、仅一份公开CA、双方无私钥／备份、release无测试CA／明文例外和自带native库。对USB生成工程的debug资源故意追加第二允许域，重新构建的APK被检查器拒绝；将CA信任移到base-config的负例也被拒绝。随后恢复原XML并重建，摘要恢复一致、检查通过，错误target也被拒绝。未安装这个扩大域的负例APK。

在既有专用API36／WebView133／x86_64 AVD保留原4条／492分：默认配置的已存凭据冷读成功，HTTP全套回归后5条／615分；替换为USB配置，六个端口经显式回环反向转发，完整TLS及HTTP脚本通过后7条／861分。覆盖有效／三类错误证书、401／307、凭据移除／重建、握手取消／超时、总时限、分块／截断／恢复、读取取消／超时等原有断言。TLS取消23毫秒检查到终态，服务端95毫秒观察到关闭，总时限2502毫秒；不是DNS或SYN黑洞证据。移除HTTP／有效HTTPS映射并验证部分添加回滚后，冷启动HTTP明确报NETWORK_OR_PROTOCOL，本地新增／同ID重放后8条／984分。恢复两项映射、再次强停冷启动，凭据不重新准备仍HTTPS成功，本地只读核对8／984通过；未清库或切换网络。此失败是映射缺失，不是手机断网证据。

Windows Node已确认同机127.0.0.1的18510–18515均可建立TCP连接，HTTP观测端点返回预期200，无需增加监听网卡或修改防火墙。USB候选debug为 `/tmp/travelflow-p0-app-usbprep/android/app/build/outputs/apk/debug/app-debug.apk`，SHA256 `e9a9de4ec3acbf81d3369dc92c4d02a0d9f8218f6e0c793d57214504757ff815`，应用ID仍org.travelflow.p0，权限仍仅INTERNET与本包内部动态接收器权限。只改变开发探针测试目标配置，没有正式发布。工程／CA私钥／APK／原始运行证据均留仓库外；CI增加emulator与usb双配置的独立构建、完整lint及打包检查，不操作设备。

此配置截至该准备轮仅在隔离模拟器执行。未更新用户手机、未创建手机反向转发、未执行真机网络或凭据测试；此前手机1条／123分及本地授权不自动扩展。下一步在候选APK和操作范围可审阅后，请用户明确是否更新该指定手机并执行USB本地虚构服务的HTTP／TLS及公开虚构凭据测试；不调用真实供应商、不读真实密钥、不切换手机网络、不修改系统CA。需要支持的旧系统64位引擎、正式凭据生命周期和TCP／DNS阶段边界仍保留。

## P0首台ARM64真机USB网络与虚构凭据验收（2026-11-09）

用户在审阅候选包与范围后明确允许继续在给定USB手机测试，授权承接此前本地验收并扩展到本包更新、USB回环虚构服务及公开虚构凭据；不延伸到其他设备／用户空间、真实供应商或密钥、切换手机网络、更新WebView、系统CA或其他应用数据。仍为同一ELI-AN00／Android16 API36、Google WebView150.0.7871.181、aarch64／app_process64；复用Windows既有ADB服务与Windows Node，不重启服务。

- 安装同签名USB debug APK，SHA256为上节的`e9a9de4ec3acbf81d3369dc92c4d02a0d9f8218f6e0c793d57214504757ff815`，显式限定当前用户。更新前后按ID／金额排序的原生账本摘要一致，保留1条／123分，没有卸载、清库或改表。能力诊断通过，布局／内容均369CSS像素，无横向溢出；不等于正式手机交互验收。
- 六项USB反向转发的实际设备监听均核对为127.0.0.1。完整TLS脚本通过：有效HTTPS中文分块，三类错误证书拒绝且无HTTP请求，401／307边界，虚构凭据移除／重建，握手取消／超时及总时限。取消后51毫秒检查到终态、服务端123毫秒观察到关闭；连接超时1537毫秒，总时限2506毫秒。这里只覆盖TCP建立后的TLS握手，不覆盖SYN／DNS阶段。
- 完整HTTP脚本通过：真实触摸、普通HTTP缓冲对照、中文分块、读取取消／超时、立即取消、并发与错误ID拒绝、截断／显式恢复、503及本地重放。读取取消45毫秒检查到终态，服务端在请求开始后150毫秒观察到关闭。
- 账本由原1条／123分，经TLS新增至2／246、HTTP新增至3／369。移除本轮HTTP映射并强停冷启动，请求明确报NETWORK_OR_PROTOCOL，本地新增／同ID重放至4／492；这证明USB映射缺失时仍可本地使用，不是手机断网测试。恢复映射，再强停冷启动，`--cold-start`不重新准备凭据仍成功HTTPS，前后均4／492。
- 结束前通过真实触摸移除专用虚构凭据，`--expect-credential-failure`验证CREDENTIAL_UNAVAILABLE且服务无请求；本地只读核对4条／492分通过。本轮六项反向映射、自己的CDP转发和测试服务均移除／停止，仅强停本包；应用及虚构记录保留，手机网络与其他应用保持原状。下次测试凭据需显式重新准备。

本轮只修改既有四份内部文档，无新增／删除文件，无应用、业务功能、依赖或共享快照变化；沿用已构建并经双配置CI通过的`8cff5c7`候选。运行证据在仓库外`/tmp/travelflow-usb-phone-*.json`，不提交序列号、凭据、APK、数据库或原始设备输出，复现不依赖这些临时文件，入口见MAINTAINING。单台ARM64／API36的本地虚构服务结果不能推广为所有ARM设备、公网供应商、硬件Keystore背书、切网、升级迁移、后台／省电或正式密钥安全已通过。P0继续补旧系统64位引擎、TCP／DNS与正式凭据策略，再由用户确认框架和拟支持范围；P1仍未开始。

## P0 Android7／8＋Chrome119的64位组合验收（2026-11-12）

沿路线图补齐此前缺少的旧系统64位引擎证据。本轮应用源码仍为`8cff5c7`，文档基线`cff1625`；没有修改应用、共享契约或设计快照，也没有重跑已有32位、较新系统或真机历史路径。复用自己的官方Google APIs/x86_64 AVD：API24 revision27的`travelflow_p0_api24_google`（5560／CDP19239），API26 revision16的`travelflow_p0_api26_google`（5558／CDP19238），不覆盖、不清数据。二者原有P0包在旧引擎下未生成实验数据库。

从[Downzen候选页面](https://downzen.com/en/android/chrome-browser-google/download/11906045193/)的正常x86_64下载入口取得APKS容器（初始无浏览器请求头返回403，常规浏览器请求头下载成功；没有绕过登录或设备授权）。容器122753730字节，SHA256 `5018c28bf2e1dac3f29e28147965e7eed9b4116632213f33e018394224c0bc8e`，含8个原版APK：主包，以及auxiliary_search、cablev2_authenticator、chrome、config.en、feedv2、read_aloud_playback、survey七个split。主包SHA256 `338f14636a0657cc126e1308d4d17569136473d21632ac35671520c546801dd8`，versionCode604519327、119.0.6045.193、minSdk24／maxSdk28，声明WebView库、无静态库依赖，含x86与x86_64的libmonochrome.so。八份逐项签名校验通过、签名集合均与独立官方Chrome69基准一致，包名及版本码一致、split名称唯一，ZIP完整性检查通过；未重签或把镜像站标签当身份凭据。只用ADB原生install-multiple安装，没有安装第三方安装器。候选准入仍只是元数据检查，不替代完整分包与实际运行。

API26明确选中Chrome119；API24安装命令曾报告`failed to finalize session`，但系统日志显示提交完成、pm path列出八个已安装分包，页面实际加载119并通过后续全套，因此保留命令异常，不盲目重装或仅凭退出码下结论。API24的dumpsys接口仍为空，提供方诊断继续记未知。两组均经本包`/proc/<PID>/exe`确认app_process64，内核x86_64；候选x86_64库ELF class2／machine62，应用映射包含Chrome的x86_64 odex。API26的navigator.platform却报Linux i686，不能用该JS字段推翻原生进程证据，也不能单看UA宣布ABI通过。

- 新生成两天有效的测试证书和独立emulator工程，新debug APK SHA256 `28a81b4193714a747d0e2e87e48efc51495f0719063426b98448bf7b3f5204be`；此前11月9日的证书已过期，不复用。JDK21／SDK36／Build Tools35.0.0离线debug、unsigned release和完整debug lint均通过，实际打包策略检查通过：唯一debug测试域／CA、release无测试CA与明文例外、双方禁备份且无私钥或自带native库。
- 两组能力诊断、完整TLS及HTTP脚本均passed:true。TLS涵盖有效／三类错误证书、401／307、虚构凭据移除／重建、握手取消／连接超时及总时限。API24／26取消分别23／25毫秒检查到终态，服务端均104毫秒观察到关闭；连接超时1511／1514毫秒，总时限2509／2504毫秒。HTTP涵盖真实触摸、中文分块、普通HTTP缓冲对照、读取取消／超时、立即取消、并发与错误ID拒绝、截断／恢复、503及本地重放；读取取消分别10／16毫秒，服务端在请求开始后112／114毫秒观察到关闭。
- 两组初始虚构账本均0，TLS后1／123、HTTP后2／246。通过各自系统设置UI真实触摸，核对飞行模式原值0→1；强停冷启动后请求明确失败，246分保留，本地新增／同ID重放至各3条／369分。恢复原值0、再次强停冷启动，`--cold-start`不重新准备凭据仍HTTPS成功，前后均3／369；本地只读断言通过。不是仅改设置值或停止服务冒充断网。
- 两组布局／内容宽度均412CSS像素，所有所需能力及两项增强检测通过；未作正式交互、安全区、权限、后台／省电、升级迁移或磁盘失败验收。已有金额未归零，没有正式财务写入。结束后恢复网络，移除本轮UI暂存文件／CDP转发，停止自己的服务和两台模拟器，保留其引擎及虚构记录；未操作用户手机或其他ADB设备。

本轮只修改既有四份内部文档，无新增／删除文件及应用功能。契约、14组账目样例与实际APK策略检查通过；双配置CI按新提交另行核对。组件、SDK、工程、证书私钥、APK及原始证据均在仓库外，复现步骤见MAINTAINING新增小节，不依赖`/tmp/travelflow-20261112-api{24,26}x64-*.json`存在。该结果补齐两组匹配的64位模拟器，不代表所有旧Android或ARM64旧机已支持；Chrome119仍是历史实验组件，不是给真实用户的更新建议。P0下一项转向TCP SYN／DNS取消边界和正式凭据生命周期提案，再整理框架与拟支持范围供用户确认；P1未开始。

## P0 SYN／DNS连接阶段边界（2026-11-12）

本轮新增`run-android-connect.py`、`check-android-connect.mjs`、`lib/connect_fixture.py`及`check-connect-fixture.py`四个开发工具，修改ProbeStream的debug固定DNS实验入口、生成器BuildConfig、实际APK检查和CI；未新增／删除正式业务功能、依赖、领域、契约或设计快照。DNS入口仅接受debug＋emulator配置的固定模式，内部生成随机`tf…p0-dns.invalid`，不接受任意域名／URL，不加入凭据；USB与release均拒绝该传输类型，release DEX另检查没有实验域名。原有单一debug信任域和CA策略没有扩大。

新建专用`travelflow_p0_connect35`（官方API35/default/x86_64，5558）及`travelflow_p0_connect24`（官方API24/Google APIs/x86_64 revision27，5560）；后者安装上节核验的Chrome119双ABI原版分包。仅这两台实例用`-dns-server 127.0.0.1`启动并将各自adbd切到root，应用仍为普通UID；不操作手机、其他AVD或宿主DNS／防火墙。故障控制器逐项核对明确模拟器序列号、确切专用AVD名、SDK、当前用户0、debug包及普通应用UID，拒绝已有CDP映射／专用链；这些前置检查不使用可能被Python优化关闭的assert。

SYN故障只对该应用UID、10.0.2.2:18510的新建SYN丢包，以专用链计数及内核SYN_SENT共同确认；DNS故障仅在该模拟器内将10.0.2.3:53的UDP转发至宿主回环18516，受控DNS收到固定虚构名的A／AAAA查询后不回复，显式释放时返回NXDOMAIN。其他名字立即否定，不记录或转发到真实DNS；控制接口仅宿主回环18517。没有用服务停止、立即拒绝或JS等待替代网络阶段证据。

| 实验 | API35结果 | API24结果 | 判断 |
| --- | --- | --- | --- |
| SYN停顿后取消 | 约7ms确认、9.6ms到取消终态，SYN_SENT从1到0 | 约10ms确认、6.1ms到取消终态，SYN_SENT从1到0 | 两组均达到本实验1秒内真正取消门槛 |
| DNS挂起后取消 | 约6ms确认；继续挂起约1224ms仍无终态，释放后才取消，回调延迟约1229ms | 约9ms确认；约1223ms仍无终态，释放后才取消，约1229ms | 两组`promptCancellationPassed=false`，未通过即时取消 |
| DNS挂起越过6000ms总时限 | 故意再等约6509ms仍无终态，释放后才发DEADLINE | 约6508ms仍无终态，释放后才发DEADLINE | 原总时限是停止信号，尚非DNS阶段的硬退出上限 |

`fixtureAssertionsPassed=true`只表示故障确实出现、观察与单终态／账本断言通过，不能覆盖上述取消失败。SYN／DNS取消期间各新增固定123分并重放，既有记录逐条保持，本地写入约11–12ms（API35），未被网络等待堵住；无终态后分块。故障前后正常HTTP基线成功，实验结束按本轮所有权删除规则／转发，未flush内置链。

首次API35实验在SYN后因DNAT规则缺少UDP条件而被系统拒绝，已清理本轮状态，保留此前1条／123分；修正后正式诊断从1／123到3／369，完整TLS回归至4／492，HTTP至5／615。API24诊断从0到2／246，完整TLS至3／369、HTTP至4／492。两组完整脚本均通过有效／错误证书、401／307、握手与读取取消／超时、原有分块总时限、截断／恢复、503与重放；再次强停冷读凭据成功，记录数／金额不变。本轮未重跑全部历史矩阵，未将DNS失败“修复”为提前发取消终态。

emulator与usb配置的debug／unsigned release、完整debug lint及实际APK检查均通过；debug摘要分别为`767c7a1f8f7da6e1e0dc19e089f25a47e2b77f9174c6049053a22830a1cd6e03`和`ea8b67f146f0332d9311b2f837d4ebc73360fcd77801bc4c12f56bcdf1d13eec`。API35实际替换USB配置后DNS入口被INVALID_OPTIONS拒绝，原生账本摘要不变；随后恢复emulator包、冷读成功。专用链已存在的实际负例拒绝且保留原链／账本，首次规则失败的清理也已核对；向unsigned release副本注入实验DNS标记的打包负例被检查器拒绝且未安装；本机UDP协议与错误设备／AVD／非root拒绝测试（含PYTHONOPTIMIZE=1）、契约、14组账目样例、类型与语法检查通过。CI增加同样的本机测试、双配置构建及release DNS资产隔离，不执行root／模拟器故障实验。

最终两台专用AVD保留5条／615分、4条／492分及各自已验证的emulator配置，故障规则／转发和服务均移除，自己的模拟器已停止；用户手机仍为此前4／492，未操作。工程、证书、APK、数据库与原始观察在仓库外，复现入口见MAINTAINING。SYN结果不能推广所有OS／网络；DNS失败及硬时限缺口已进入框架评审。下一项先验证可取消解析与传输组合，再收口正式凭据生命周期和支持提案；P0仍未完成、P1未开始。

## P0可取消解析与独立客户端对照（2026-11-12）

在`81b8409`基线上新增显式`--transport-probe okhttp`的debug对照，固定`com.squareup.okhttp3:okhttp-android:5.3.2`；不是最新版本承诺或正式依赖决定。默认emulator／usb配置不加入该客户端，release不编译实验插件、客户端或debug许可资产。新增源文件为ProbeAsyncStreamPlugin、LICENSE／NOTICE与check-android-async.mjs；生成器、证书／对端、连接故障工具、APK检查、CI及本轮四份内部文档同步修改，无删除，无正式业务、领域或共享快照变化。原页面按钮仍使用ProbeStream，没有自动切换客户端或修复旧实现。

方案核对：[固定版本OkHttp源码](https://github.com/square/okhttp/tree/parent-5.3.2)提供可注入Dns接口，默认实现仍调用阻塞式系统解析；源码声明Android21+，Apache-2.0许可随可选debug包附带，POM的Okio3.16.4、Kotlin stdlib2.2.21及AndroidX依赖另记NOTICE。只使用平台TLS和客户端默认主机名校验，不自建HTTP／TLS栈、不硬改URL为IP、不指定公共DNS供应商。

| 自动解析分支 | 实现与实测范围 | 仍未满足的条件 |
| --- | --- | --- |
| API29+ | Android DnsResolver的CancellationSignal；异步查询经可唤醒等待接入OkHttp Dns，取消完成后才释放请求工作项／发单终态 | 本轮只测API35固定网络；代理、Private DNS、切网及更广系统范围未验 |
| API24–28机制对照 | 仅debug固定模拟器DNS端点与固定虚构名的UDP A记录；关闭自身套接字唤醒等待，再由OkHttp保持域名URL发HTTPS | 不是通用DNS解析器，未实现CNAME、TCP回退、搜索域、通用IPv6与网络选择；不能据此宣布旧系统正式DNS支持 |

复用本项目专用API35/default/x86_64（WebView124）与API24/Google APIs/x86_64（Chrome119），实际进程均app_process64。旧账本分别5／615、4／492，保留数据安装可选debug。沿上一节的隔离DNS／SYN故障工具运行`--client okhttp`；按本次请求的随机实验域名关联挂起查询，避免旧重试或缓存冒充当前解析。

| 对照 | API35结果 | API24结果 |
| --- | --- | --- |
| SYN取消 | 约6.7ms到终态 | 约7.0ms |
| 仅更换HTTP库，保留Dns.SYSTEM | DNS继续挂起1.2s仍不能结束，释放后约1235ms才取消 | 同类结果，约1233ms；单换库没有解决问题 |
| 自动可取消分支 | DNS取消约2.0ms；释放对端前请求、解析、套接字、调用及连接的活动计数均0 | 受控UDP约5.3ms，计数同样归零 |
| DNS总时限 | 约6005ms发DEADLINE，6500ms检查时已结束 | 约6004ms，同样已结束 |

自动分支取消及总时限之后，**在DNS对端仍挂起时**均能再次完成正常HTTP，随后才释放原DNS对端；校验单终态与终态后无追加事件。活动计数指应用持有的请求资源，不宣称系统共享DNS服务或整个执行器没有后台活动。每组SYN、系统解析对照、自动取消各新增123分并同ID重放，旧条目逐条保护；API35至8／984、API24至7／861。

通过固定`valid.p0-dns.invalid`的A正例继续发真正HTTPS：服务端核对Host为该域名:18511，TLS回调核对SNI为原域名。有效证书与中文分块通过；DNS域上的不信任、主机名不匹配、过期证书均TLS_FAILED且没有HTTP请求。缺失凭据不发请求，移除／重建专用公开虚构凭据通过，401／307不跟随、503、截断与Last-Event-ID恢复、读取取消／超时、握手取消、分块总时限、立即取消三次、并发和错误ID拒绝、请求资源归零均通过，账本不变。机制初版后补充了凭据错误分类与恢复字段，最终包的上述TLS／SSE路径在两组独立复验。

可选配置单独生成匹配TLS材料，仅debug增加一个精确DNS域的CA信任，明确不含子域且不允许该域明文；原IP域和所有默认／release策略保持原状。debug／unsigned release和完整debug lint通过，实际APK检查确认release没有实验DNS域、插件或OkHttp客户端；没有自带.so。非法usb＋okhttp、配置混用在生成目录前被拒绝。实际构建的“DNS信任包含子域”负例被检查器拒绝且未安装；恢复策略后检查通过。恢复包摘要`25615ec942760fd8a230028cbaf763acbc8a4906869fa900d61e4c70ba869a97`与实际安装复验包`fabd97bbd6d97a6204f5cf83fa29dec9621fa3aa9d41a7ffdaa592550ffd2554`不同：增量重打包条目布局变化，全部ZIP条目内容逐字节一致、签名均有效且证书相同，不能说整个APK逐字节一致。

原客户端API35完整TLS／HTTP回归通过，追加至10条／1230分；API24原客户端不重新准备凭据冷读成功，保持7条／861分。当前能力与原生桥诊断通过；不是正式交互验收。契约／快照、14组账目样例、类型、脚本与四项本机DNS／设备拒绝测试通过。CI扩展为默认emulator、默认usb与可选emulator／okhttp三组独立构建、完整lint及打包检查，不执行设备故障操作。

复现见MAINTAINING新增小节。SDK、工程、证书私钥、APK、数据库及`/tmp/travelflow-p0-async*.json`均不进Git、不作为接续前提；清理本轮链／转发／服务并停止自己的两台模拟器，保留记录。手机本轮未操作。下一项比较可维护的旧系统通用解析方案，并补代理／网络选择等组合边界，再收口正式凭据与框架／支持提案；P0仍未完成，P1未开始。

## P0旧系统DNS报文兼容层与网络约束（2026-11-12）

承接`048d2e6`的机制对照，将可选debug分支的固定UDP A解析替换为`CancelableDnsLookup`：固定MiniDNS core 1.1.1只处理DNS报文，本项目持有并关闭UDP／TCP套接字。新增该兼容层、上游许可选择文本、JVM协议检查及Android协议／代理拒绝检查；修改可选插件、生成器、对端／控制器、APK检查、CI、第三方来源说明和本轮四份内部文档；无文件删除、无正式业务／领域／共享快照变化。它仍是可逆的隔离实验，不是正式依赖或最低版本决定；方案比较与维护代价见ANDROID_FRAMEWORK_REVIEW。

旧分支新增A／AAAA、最多8跳且检测循环的CNAME、UDP截断转同一DNS服务器的TCP、TCP长度帧与响应ID／问题校验；错误UDP包不延长等待预算。兼容层总预算10秒，应用请求仍在6000ms触发实际关闭，不靠提前发终态或取消Future掩盖阻塞。每次请求读取当前Android Network及其LinkProperties的DNS服务器；DNS和HTTP分别绑定同一网络，API29+平台查询也显式传该Network。没有硬编码公共DNS、改写业务域名URL或新增CA域。仅可选debug增加ACCESS_NETWORK_STATE，默认emulator／usb和release不增加该权限、MiniDNS或实验插件。配置代理或活动Private DNS时实验客户端明确拒绝，后者尚未实测；这不是正式代理／加密DNS支持。

主机JVM使用真实回环UDP／TCP完成12项：A、CNAME、UDP转TCP、AAAA解码、错误ID、错误问题、畸形包、CNAME循环、NXDOMAIN、截断TCP、UDP取消及TCP取消。错误响应故意带污染地址，必须被忽略后采纳正确响应；取消检查等待实际I/O线程退出与套接字计数归零，TCP对端还须观察到peer_closed。使用生成工程导出的同版Jar运行；这不是Android或IPv6路由证据。五项Python本机检查另覆盖DNS协议、错误设备／AVD／非root拒绝、TCP监听独占和关闭后同端口重启。

复用两台专用64位AVD保留数据安装新包，debug SHA256 `9df7d84019e1eb41551c2aefbbb355fe5dd9b0bfa277d32bc4fe30f2767c7c81`。API24／Chrome119的完整新客户端对照通过：UDP DNS取消约3.6ms，DNS总时限6006ms；CNAME与UDP转TCP均实际用于域名HTTPS，Host／SNI保持原valid域、授权与三段中文流正常。循环CNAME、截断TCP明确DNS_FAILED且无HTTP；AAAA文档地址被固定对端限制拒绝，没有据此测试IPv6连通。TCP挂起取消约8ms、总时限6003ms，对端均观察到关闭，活动资源归零、单终态且无晚到事件。新增协议组账本只读；原有SYN／系统DNS对照／自动DNS取消各新增123分并重放，由7条／861分至10条／1230分，逐条保护历史记录。

API35／WebView124平台分支完整回归通过：SYN取消约7ms、DNS取消约3.9ms、总时限6004ms；原阻塞系统DNS对照仍需释放后约1229ms才结束，没有宣称它已修复。两组自动分支在旧DNS回复仍挂起时均能再完成新HTTP；完整域名TLS／401／307／503、凭据缺失／重建、截断／恢复、握手与读取取消／超时、分块总时限及请求资源检查均通过。API35原10条／1230分按同样三次故障写入至13条／1599分；未重跑其他历史矩阵或操作手机。

代理负例仅在这两台专用AVD临时设置127.0.0.1:18510，不改变宿主网络。原生均返回PROXY_UNVERIFIED，无HTTP、无账本变化，随后恢复完整代理设置并冷启动验证正常HTTP。首次清理发现Android会把旧http_proxy键转换为global_*配置，仅删原键没有清除生效代理；修正为先用系统认可的空代理清除实际状态，再精确恢复五个相关设置（含原来不存在的键）。shell参数统一引用以保留空值；恢复结果比较与冷启动HTTP都属于通过条件。TCP对端首次连续启动也暴露TIME_WAIT占用，改用SO_REUSEADDR但不开SO_REUSEPORT，仍拒绝已有监听器，增补独占／重启检查。上述失败没有被记为通过或通过清库解决。

可选工程debug／unsigned release／完整debug lint通过（0错误、17警告，含模板资源、版本提示及既有TargetApi建议），三种配置的实际APK检查均通过：新库／插件／网络状态权限仅可选debug出现，release无实验域／CA／明文例外／新库／权限，无自带.so、私钥或备份。默认两配置复查的是此前构建APK，本轮新构建为可选配置；CI三组会从当前生成器独立重建。契约／快照、14组账目样例、类型、脚本及上述本机检查通过；构建、模拟器与CI分别记录。复现见MAINTAINING，工程／证书／APK／原始证据在仓库外，不作为接续前提。

本轮故障链、转发与临时代理已核对清理，两台自己的AVD和对端已停止，数据保留；手机及其他设备未操作。当前缺口仍包括缓存／搜索域与完整服务器失败预算、真实IPv6路由、代理适配、Private DNS、VPN／切网／网络丢失、真实供应商和正式凭据生命周期。MiniDNS复用减少报文代码，套接字调度和系统语义仍由本项目维护，不能直接宣称“旧Android通用DNS完成”。下一项按PRODUCT_ROADMAP补网络变化与上述兼容语义的提案／关键验证，再评审正式维护成本与凭据方案；P0未结束、P1未开始。

## P0请求网络丢失与重连实验（2026-11-12）

承接`bde3388`，只扩展可选debug客户端，正式客户端／框架和最低版本仍未确定。新增`check-android-network.mjs`与`lib/network_fixture.py`；修改ProbeAsyncStream、故障控制器／对端、既有资源断言、本机检查、CI及四份内部文档，无文件删除、无新依赖或权限，不改SQLite模式、固定123分语义、领域契约或设计快照。

每个自动解析请求被动监听网络，只处理本请求绑定Network的onLost：在独立关闭线程停止解析和HTTP，不自动重发；默认网络改变但旧Network仍存在时，不将其冒充实际丢失。正常、错误、取消和总时限均在发终态前注销监听；新增networkWatches计数与绑定／当前Network、丢失通知相对时间诊断，清理失败明确报错，不能假报资源归零。只使用ACCESS_NETWORK_STATE及已有权限，不调用requestNetwork或全局绑定进程。注册前后网络已消失的窗口另检查LinkProperties；未覆盖所有竞态或VPN。依据[Android网络状态与回调语义](https://developer.android.com/develop/connectivity/network-ops/reading-network-state)，普通网络监听的onLost与默认网络监听含义不同，回调须及时注销。

复用专用API24／Chrome119及API35／WebView124的x86_64／app_process64 AVD，保留数据更新同一debug包，SHA256 `fe26834c4f4896132fe18dcbfb5419a38b0c2c5aa4449e45f632329a0aa216a4`。两台当时只有蜂窝虚拟网络；本轮只证明断开／重建和新Network选择，**不是Wi-Fi／蜂窝并存时的无缝切换**。控制器先验证精确AVD、SDK、root adbd和普通应用UID，再通过svc停用该AVD的Wi-Fi／数据；保存并恢复原开关值及订阅设置键存在性，不改变飞行模式或宿主网络，不操作手机。

| 自动分支与挂起位置 | 最终实测终态 | 通知到终态／资源 |
| --- | --- | --- |
| API24：UDP DNS、DNS转TCP、TLS流式读取 | NETWORK_LOST，分别确认挂起查询／TCP请求／首块已发生 | 按毫秒时钟测得0–3ms；请求、解析、套接字、HTTP调用／连接、网络监听均归零 |
| API35：平台DNS、TLS流式读取 | NETWORK_LOST，平台查询与读取分别验证 | 约2ms；同样归零 |

从测试开始停用无线到终态另计约330–381ms（API24）与115–118ms（API35），不将系统处理开关的时间当关闭回调耗时。故障控制器还从/proc/net/{tcp,tcp6,udp,udp6}核对本包UID、固定对端及非零inode，最终无应用持有的实验套接字；这不宣称系统共享DNS服务也没有后台活动。恢复前新请求返回NETWORK_UNAVAILABLE且无HTTP；每阶段离线追加123分并同ID重放，旧记录逐条保持。恢复时使用新的Network标识，显式新请求成功完成原域名HTTPS、Host／SNI、公开虚构授权及三段中文流；旧请求在后续网络变化后也无追加事件，没有自动恢复或重放旧请求。

两组还在无线关闭时强停本包、冷启动：原生桥与完整虚构快照保留，联网明确失败，仍可新增／重放123分。控制器比较冷启动前后的完整旧快照，恢复原设置后再次冷启动普通HTTP成功。每次完整网络组API24新增4条、API35新增3条；本轮包括针对失败的复验，最终API24由10条／1230分至24条／2952分，API35由13条／1599分至26条／3198分。失败前已提交的虚构记录均保留，没有清库来重跑。

本轮暴露并保留两类测试边界。其一，API35首轮重连后的首个域名请求失败，后续复跑通过；首次未保存具体终态，**根因未确定**，不能认定为已修复。诊断现会在失败时保留阶段、终态、Network与对端状态；恢复正例改为先观察同一Network连续750ms，再严格检查真实HTTPS成功，最终两组通过，没有引入自动重试。这个窗口只限定受控实验的稳定前提，不代表生产网络就绪算法或服务可达性保证；该首次失败仍列P0复现缺口。其二，API24复验曾在应用FD已关闭后，对端TCP仍半开，旧测试错误地要求立即重置对端模式；断网可能阻断关闭通知，不能用服务端立即收到FIN作为跨网络保证。现在先确认应用FD和监听归零，再将必要的宿主对端清理单列为tcpFixtureClosed，不计入tcpPeerClosed；最终TCP阶段应用FD已归零而对端仍半开，工具单独清理1个对端连接；此前也有对端实际观察关闭的结果，不推广为跨网络保证，另有真实回环测试防止归因混淆。

完整debug lint首次发现clearCapabilities是API30接口，已改用API21可用的removeCapability，不提高minSdk、不压制检查。独立可选工程debug／unsigned release、完整debug lint及实际APK隔离检查通过；没有新增权限或运行时依赖。API24 DNS协议／TCP取消／6000ms时限、两组完整TLS／SSE／凭据失败／错误证书／立即取消回归通过，并将网络监听归零纳入既有资源断言；这些组只读账本。主机JDK21的12组DNS协议、9项Python协议／错误设备拒绝／无线部分失败恢复／半开对端归因、契约／快照、14组账目样例、类型与脚本检查通过；未重跑全部历史兼容矩阵。CI仍为三配置独立构建／lint／打包及主机测试，不执行模拟器或切网。

复现见MAINTAINING，证据、工程、SDK、证书、APK与数据库均在仓库外；结束后核对无线与代理原状态、故障链及自身转发均已清理，自己的两台AVD与对端已停止，数据保留。未覆盖并存网络切换、VPN、Private DNS、正式代理、真实IPv6路由和公网供应商，也未修改原ProbeStream的阻塞DNS对照。下一项优先复现API35恢复首请求失败，再依据ANDROID_FRAMEWORK_REVIEW的兼容语义提案收口正式维护成本与凭据／支持范围取舍；P0未结束，P1未启动。

## P0恢复首请求的定向复现与分阶段诊断（2026-11-12）

承接`2328e2c`，本轮针对上节API35首次恢复请求失败做有界复现，**未再复现，也没有认定已修复**。新增文件／删除文件均无；修改既有ProbeAsyncStream、网络检查与控制器、设备拒绝测试及四份内部文档。新增的是可选debug诊断与只读复现入口，不改变请求总时限、自动重试、TLS信任、域名、正式传输或账本策略，无新依赖／权限，共享契约与设计快照未动。

先沿用上轮实际安装包，API35专用AVD冷启动，交替在随机DNS挂起与TLS读取首块后关闭无线；恢复后只等Network重现，不等750ms稳定窗口就发首个域名HTTPS。五次先保留旧DNS挂起回复，另五次按原流程等待200ms、先释放旧DNS回复再发新请求，全部成功。两种顺序用于检查旧解析与新Network的相互影响，不能将它们混称同一复现条件。后来加入诊断的新包，在原顺序再做五次，也均成功。合计15次正常首请求未失败；这不是故障率估计或原问题修复证据，首次失败因缺少原始具体终态仍待证据。

新debug包SHA256 `267913777eac9a5b1403b40f9f97e0ca162058700834bbf1eff375bf6e0f2de6`。复用既有OkHttp5.3.2的EventListener，保留闭合的networkPhase标签（preparing／dns／dns-ready／tcp／tls／tls-ready／headers／body）；这是最后观察到的阶段，不直接等于根因或业务内容已被读取。API29+另记平台dnsRcode、dnsErrorCode及可取到的errno，未发生／不适用为-1；本轮正常与503负例均看到rcode=0，未触发系统DNS错误码路径。事件记设备时钟，控制器记宿主时钟；resources只额外给当前DNS服务器数量、代理和Private DNS布尔值，不输出服务器／代理地址、任意URL、请求头、证书、底层异常文本或凭据。没有把这些调试字段扩成正式产品接口。

新增闭合参数`--case reconnect`复用现有网络工具：每组五次，不写账本；原请求真正结束、监听与工作项归零后，重建网络发显式的新ID请求，完整保留首请求终态／绑定与当前Network／DNS对端状态，再以另一个ID做稳定后的对照。后者不覆盖前者，也不是客户端自动重试。读取挂起时先实际观察本包持有固定对端套接字，再检查关闭后归零，给FD检查补正例；API24自有DNS路径也要求正例。物理设备拒绝检查同时覆盖两个新增诊断参数，仍在任何ADB命令之前拒绝。

`--case reconnect-negative`只跑一次，明确注入虚构HTTP503：API35及API24均保留首请求HTTP_STATUS／503，DNS与TLS已完成，资源归零；稳定后的不同ID请求正常通过域名Host／SNI、公开虚构授权及三段中文流。输出fixtureAssertionsPassed=true、firstRequestFailures=1、allImmediateRequestsPassed=false，命令返回0仅表示诊断／数据保护断言通过，不能说首请求成功或把注入失败当成历史故障复现。正常五次组对应firstRequestFailures=0，但仍不能说历史问题已消失。另发现并修复证据保存缺口：旧脚本在后续对照／断言失败时可能只留下最后错误；现在异常路径也输出已有部分JSON，父控制器在非零退出时保留匹配场景的报告。临时在503首请求后故意抛错，实际验证命令非零、外层fixtureAssertionsPassed=false，首请求事件和firstRequestFailures=1仍在；随后按原文本恢复源码，临时抛错代码未保留。这是诊断缺陷修复，不是原网络失败修复。

同一新APK在API35／WebView124与API24／Chrome119的专用x86_64 AVD安装，进程仍为app_process64。两组完整可选TLS／SSE回归及API24 DNS协议、TCP取消与6000ms时限回归通过；错误证书、凭据缺失、401／307／503、显式恢复、读取／握手取消和超时等原有终态与监听资源断言保持。新代码debug／unsigned release、完整debug lint和实际APK隔离检查通过，无新权限、私钥、native库或扩大信任；默认／release不加入新诊断插件。九项Python设备拒绝／协议／恢复检查、契约／快照、14组账目样例、类型及脚本语法检查通过；原DNS报文算法未改，不重跑全部历史矩阵。CI继续按三配置独立构建／lint／打包及主机测试，不运行模拟器。

本轮所有定向诊断和回归账本只读，完整快照逐条保持，API35仍26条／3198分、API24仍24条／2952分；公开虚构凭据的准备／回归单独执行，不接触真实密钥或用户业务数据。工程、APK、证书及原始JSON均在仓库外，不作为接续前提，复现入口见MAINTAINING。手机与其他设备未操作；结束时已核对无线／代理原状态、故障链与自己的转发，自己的两台AVD和服务已停止，专用AVD数据保留。

调查结论是“已有可保留失败的复现入口，15次正常尝试未复现”；原失败继续标为待证据，不通过不断追加相同循环来宣布成功。后续在复发时依现有字段定位，独立推进评审中的服务器失败预算／缓存／搜索域及代理／Private DNS维护归属，再交用户确认正式框架与拟支持范围、凭据取舍。P0未结束，P1未开始。

## 2026-11-13：旧系统DNS共享期限与多服务器回退

从干净的main／origin/main `6a7f8cd`承接P0下一项；未重复原API35恢复首请求的15次循环，其首次失败仍未定因。本轮只推进可选debug解析器的服务器失败预算，不采纳正式框架、依赖或最低版本，版本仍0.0.0。

修改CancelableDnsLookup／ProbeAsyncStreamPlugin：旧分支使用Job创建时同一个绝对期限，覆盖UDP、TCP回退、换服务器、A后AAAA及CNAME；外层实验仍6000ms（drip为2500ms），helper单独使用的便捷构造仍默认10秒。有备用服务器时，每台单次UDP＋TCP取剩余时间的均分份额且最多1000ms，最后一台使用全部余量；无效UDP包、协议切换或别名跳转不重置期限，解析／清理后再查期限，过期结果不能被接收。SERVFAIL／REFUSED转下一台，NXDOMAIN立即失败；过期异常映射同一DEADLINE停止原因，保留真正关闭后单终态。1000ms是可逆实验策略，未变为产品取值；A与AAAA仍顺序且无类型保底份额，AAAA失败不会返回已得到的部分A结果，不能据此称完整解析语义完成。

新增`scripts/check-android-dns-budget.mjs`；修改控制器、DNS对端、Java／Python主机验收、既有TLS验收、CI语法入口及四份内部文档。没有文件删除、新运行时依赖／权限、业务／领域／共享契约或设计快照变化。闭合的fixture-pair仅限旧系统固定dns-valid，两个地址为同IP10.0.2.2的18516／18518端口，DNS与HTTP绑定同一当前Network；正常auto继续读LinkProperties的真实DNS列表，无公共DNS硬编码或全局配置修改。该实验只是两台可控逻辑服务器，不是不同DNS地址／实际供应商网络证据；API29+明确拒绝该选项。

JDK21真实回环UDP／TCP共26项通过（原12＋新增14）：首台丢包／SERVFAIL／REFUSED／连续错误ID／TCP停顿的备用接手、两台错误、NXDOMAIN不回退、两台无回复、A与AAAA／CNAME共用期限、已过期不打开socket、备用TCP取消与对端peer_closed，以及清理后拒绝过期结果。800ms主机总期限的无回复／AAAA／CNAME／TCP组约801–802ms；清理后过期组故意每次阻塞计数钩子450ms，约958ms拒绝结果，证明期限复查而非能够抢占任意阻塞清理。所有资源归零，峰值不超过一个DNS套接字；不是Android或公网IPv6路由测试。九项Python设备／协议／恢复检查（含优化模式）、契约／固定快照、14组账目样例、类型与修改脚本语法检查通过。

复用自己两台专用AVD并保留数据；安装最终debug SHA256 `5f495a8a70595b95eaa598ca91615609325e765a7ff3609cc6f6eb1a777de48b`。实际提供方／版本及运行进程仍为API24／Chrome119.0.6045.193、API35／com.android.webview124.0.6367.219，均app_process64，未用配置值替代实际加载核对。

| 本轮实际Android验收 | 结果与边界 |
| --- | --- |
| API24固定双DNS：首台drop／SERVFAIL／REFUSED／UDP转TCP后挂起 | 备用实际处理A与AAAA，再完成原域名HTTPS、Host／SNI、公开虚构授权及三段中文；总耗时分别4740／2722／2718／4724ms，含HTTP流式读取 |
| API24固定双DNS：NXDOMAIN、两台drop、备用查询中取消 | NXDOMAIN约7ms为DNS_FAILED且无备用／HTTP；两台drop约6003ms为DEADLINE；取消后约38ms检查到结束；真实应用FD与工作项／解析／DNS套接字／HTTP／连接／监听归零，无晚到事件 |
| API24健康首台及原auto协议组 | 健康首台约2716ms完成HTTPS、不查询备用；原CNAME／TCP回退、循环／截断拒绝、TCP取消及6000ms总时限回归通过 |
| API24／35可选TLS／SSE全组 | 错误证书、凭据缺失／重建、401／307／503、截断与显式恢复、握手／读取取消及超时等既有断言通过；API35仍平台解析且拒绝fixture-pair |

所有本轮Android组完整账本只读，API24仍24条／2952分、API35仍26条／3198分；公开虚构凭据准备与移除／重建单列，不读取真实密钥或用户业务数据。最终工程debug／unsigned release、完整debug lint通过（0错误、14警告）；实际APK检查通过，可选插件／依赖／权限仍仅debug，release无实验域／CA／新库／私钥／native库，信任范围未扩大。本轮只新构建可选配置，默认emulator／usb由对应提交CI独立重建；CI仍三组构建／lint／打包与主机检查，不运行模拟器。本机通过不代替该提交远端CI。

复现命令及前提见MAINTAINING；工程／SDK／证书／APK／原始JSON均在仓库外，不作为接续前提。未切换无线或代理，结束核对两台原无线0／1／1、代理空、故障链与自身转发均无残留，所有18510–18518宿主对端释放，自己的AVD与服务已停止、数据保留。手机及其他设备未操作；未重跑全部历史兼容矩阵、网络丢失周期或真实供应商。

本阶段关闭的是受控实验中的“首台耗尽等待／协议切换重置预算”缺口。下一项收口缓存／搜索域、A与AAAA份额／部分成功、代理／Private DNS等语义由谁维护及必要验证，再交用户确认正式凭据、框架与支持范围；不默认继续扩展自研解析器。原ProbeStream阻塞DNS、API35偶发恢复首请求失败、实际多DNS／IPv6／VPN／代理适配等边界均保持，P0未结束、P1未开始。

## 2026-11-13：解析维护责任与下一项对照评审

承接干净main／origin/main `0e35cc2`；该版本远端CI43360440034三组已通过。本轮仅修改ANDROID_FRAMEWORK_REVIEW、MAINTAINING、PRODUCT_ROADMAP与本页四份现有内部文档，无新增／删除文件；无应用功能、运行时依赖、权限、业务／共享契约／设计快照增删，不重新构建或运行历史模拟器矩阵。

只读核对固定OkHttp Android5.3.2发布源码Jar与AOSP android-15.0.0_r1的DnsResolver／Network，归属与原始链接见评审。平台查询已有网络能力判断、查询完成后的双栈聚合／排序与部分结果语义；外层期限先到仍会取消，不能理解为首个地址到达就返回。FLAG_EMPTY未主动关闭平台缓存，但指定名称的DnsResolver.query不等于完整系统getaddrinfo，搜索域／hosts／DNS64不能由此算已支持。旧层无缓存／搜索域、顺序A后AAAA及部分结果丢失的既有边界保持；OkHttp代理路由还会涉及代理主机解析，删除拒绝不能直接获得代理支持。Private DNS官方要求、缓存中不存在与解析失败的区别及RFC9520更新也已补入评审；没有据源码宣称新Android行为通过。

形成两条可审阅的旧系统路线：继续承担MiniDNS core以外的完整客户端语义，或先验证本包私有辅助进程承载Network.getAllByName、以结束本次辅助工作实现取消的机制。推荐先做第二条的有界可选debug对照，尚未实现、尚未行为验证、未采纳为正式架构；需分别证明真实退出／期限、Binder与迟到结果、主进程／账本保护、新请求及原域TLS身份、debug／release隔离，具体完成与失败退出条件见评审。不提高最低Android、不停止主应用、不终止其他应用、不把同UID辅助进程当安全沙箱；性能调查仍暂缓。

已询问正式服务地址是否需要自定义；用户要求先理解意义、收益与风险，尚未作出产品选择。评审区分完整域名、局域网IP与企业短名称，说明手机独立使用、凭据按目标隔离、证书／网络可达性与协议行为等取舍；不将未答复当作只使用预设供应商，也不据此批准任意目标／真实凭据入口。正式凭据生命周期及框架／支持范围仍待用户确认。

本轮实际验证是固定发布／平台源码查阅、本地对应实现与文档入口交叉核对及文档差异／相对链接检查；没有启动ADB设备、模拟器或服务，没有安装APK或改变账本／配置。此前26组主机与API24／35运行证据仍归属于上一节版本，不能写成这次重新运行；本次远端CI按对应文档提交独立核对。P0仍进行中，版本0.0.0，无正式发布；下一项以评审列出的辅助进程对照完成条件推进，原ProbeStream阻塞DNS和API35偶发恢复首请求失败保持未解决记录。

## 2026-11-13：地址范围确认与旧系统解析辅助进程

用户在了解意义、收益与风险后确认采用预设服务商＋高级自定义地址，优先完整域名／局域网地址、默认HTTPS及按目标服务隔离凭据；短主机名／搜索域、内网HTTP及自定义CA仍单独评审。这是正式功能的范围决定，尚未实现地址配置／真实凭据入口，不等于批准正式框架、解析器或凭据生命周期的全部取舍。

从干净main `3656213`承接P0机制对照；该基线三组CI43375712206已通过。新增SystemDnsWorkerService.java、SystemDnsLookup.java与check-android-dns-worker.mjs，修改可选插件／生成器、控制器／设备保护、APK检查、既有TLS守卫、CI语法入口及四份内部文档；无文件删除，无新运行时依赖／权限／CA域、领域／共享契约／设计快照变化。正式应用版本仍0.0.0，配置功能、P1与正式发布未启动。

只有显式可选okhttp debug生成新服务，非导出、同UID的`:p0_dns`进程，不是isolatedProcess安全沙箱；默认emulator／usb与release均不包含它。服务只接收固定虚构DNS名、当前Network与本包回调；后台线程调用Network.getAllByName，不初始化账本／凭据／HTTP。os-worker及固定400ms绑定延迟负例os-worker-bind-delay仅旧系统DNS实验传输允许，API29+拒绝；正常auto仍为原平台／MiniDNS路径，没有默认切换客户端或接受任意目标／待杀PID。

调用方用一次绑定承载一次解析，解除绑定后服务结束自身，只在对应Binder死亡后减绑定计数并让解析返回；普通断连不能充当死亡证据，重连不能变为旧请求的自动重试。取消在绑定回调前发生时也等待可解绑连接，结果／旧死亡通知不能覆盖新绑定，线程中断仍先收尾。公开调试字段只增加绑定计数与本包辅助PID，名称、底层异常及凭据不返回。该机制有额外的Binder／服务生命周期责任，尚未正式采纳；没有声称任意启动卡死都能硬实时中断，也不保证系统共享DNS服务终止旧查询。

最终debug SHA256 `039515cb072591c05d8777284343df5ac0a65251c619e3f27bc6f22f51e384b9`，独立工程debug／unsigned release与完整debug lint通过（0错误、14警告）。实际APK检查按Manifest XML树核对服务归属／非导出／独立进程，release还拒绝辅助类及实验库；另将实际APK dump文本的exported改true、进程改主进程，两项均被拒绝，未构建或安装篡改APK。默认两配置本机未新构建，由对应提交三组CI独立重建／检查；没有新签名、私钥、自带native库或扩大信任。

两台自己的专用x86_64 AVD实际加载提供方已核对：API24／Chrome119.0.6045.193与API35／com.android.webview124.0.6367.219，均app_process64且有可执行提供方映射。安装保留数据；本轮新辅助路径只在API24运行。最终14项结果：

| API24辅助进程组 | 实际结果 |
| --- | --- |
| 正常域名HTTPS | 系统解析后辅助工作已结束，原Host／SNI、公开虚构授权与三段中文通过；约2926ms含流式读取 |
| 实际DNS挂起时取消／总期限 | 开始先确认随机DNS名、本包辅助PID及一条绑定；取消后约156ms检查结束；DEADLINE终态6034ms，绑定／工作项／解析／HTTP／连接／监听归零、辅助进程不在 |
| 意外退出 | 控制器核对确切进程名与应用UID后仅终止该辅助PID，DNS_FAILED；注入后约143ms检查结束，主应用保持存活 |
| 三种停止之后的新ID | 旧系统DNS回复仍挂起时均能用新辅助PID完成原域HTTPS；不是旧HTTP自动重发，随后释放旧对端，无晚到事件 |
| 绑定延迟与立即取消 | 固定400ms onBind延迟中取消约461ms检查结束；三次立即取消均单终态、最终无辅助进程；未穷举所有Binder调度竞态 |
| 主机名不匹配／不信任／过期证书 | 均TLS_FAILED且无HTTP到达，不降低校验；全组主应用PID和完整账本快照不变 |

API24默认auto的CNAME／TCP回退、错误响应／地址限制、TCP取消及6000ms期限回归通过；API35完整可选TLS／SSE回归通过，三个旧系统实验解析选项均INVALID_OPTIONS、不发HTTP，平台分支保持。所有本轮组账本只读：API24仍24条／2952分、API35仍26条／3198分；会准备公开虚构凭据，不读取真实密钥。九项Python设备拒绝／恢复检查（含新worker物理serial拒绝）、契约／快照、14组账目样例、类型、修改脚本语法与文档链接检查通过。MiniDNS报文算法未改，不本机重跑其26项或全部历史矩阵；对应提交CI继续运行主机检查与三配置构建／lint／打包，不跑模拟器。

首次初版worker运行在控制器读取`/proc/net/*`时ADB非零且输出空，导致本机状态请求关闭；部分报告留下正常HTTPS，但在途只有ID、没有终态，原现场不足以判断该次请求结果。没有把它算通过或定为应用故障；随后同一初版包一次完整组通过，收紧Binder死亡／重连处理后的最终包再次完整通过，原读取失败未再复现、仍未定因。补强后续异常路径尽量采集在途事件／资源／可用对端状态，缺失明确标记；空ADB错误附退出码与固定命令前缀，未添加盲目重试或放宽资源断言。该情况与既有API35恢复首请求失败分别保留，不能合并为同一根因或宣称后者修复。

复现见MAINTAINING的“旧系统系统解析辅助进程”，SDK、AVD、工程、证书、APK与原始报告均在仓库外；未切无线／代理，结束核对原0／1／1、代理空、无辅助进程／故障链／自身转发，自己的两台AVD与对端已停止、数据保留，18510–18518端口释放。手机及其他设备未操作。未验辅助路径的网络丢失、Private DNS／代理／VPN、系统缓存／搜索域／真实双栈、后台／省电与真实供应商。下一项按评审有界验证辅助工作在网络丢失时的退出／解绑／新网络新请求，并收口Private DNS拒绝／恢复条件与正式维护路线；正式框架／支持范围和完整凭据生命周期仍需确认，P0未结束。

## 2026-11-13：辅助路径网络丢失与严格Private DNS边界

从干净main／origin/main `fc178b4`继续P0；基线CI43380152069三组通过。新增check-android-private-dns.mjs，扩展既有worker检查器的只读network模式、控制器、网络／DNS对端、设备保护与恢复检查、CI语法入口及四份内部文档；仅修改可选插件的Private DNS启动前保护与布尔诊断，无文件删除、新依赖／权限／服务／CA域、正式地址配置、业务／共享契约或设计快照变化。版本仍0.0.0，未正式采纳框架／传输路线或发布。

API28+现在同时检查isPrivateDnsActive及getPrivateDnsServerName()!=null，任一成立即PRIVATE_DNS_UNVERIFIED；resources另给currentPrivateDnsStrict布尔值，不暴露服务器名。官方LinkProperties约束与维护归属见ANDROID_FRAMEWORK_REVIEW。该检查仅在新请求开始时，不证明请求中的配置变化已被处理；本轮实际严格样本两项均true，未单独触发“只有名称非null”的分支。默认ProbeStream仍保持原对照，正常auto的解析选择未变。

独立可选工程debug／unsigned release及完整debug lint通过（0错误、14警告）；实际APK隔离检查通过，辅助服务仍仅可选debug、非导出、独立进程，release不含实验库／CA／辅助类或新诊断插件，无新增native库或私钥。最终debug SHA256 `3f1c0a8aeffc40685745d7d974fcb08e3ff4d4f09781cc35ffa07494038a52da`。本轮只本机新构建可选配置，默认emulator／usb由该提交CI独立重建；构建与Android运行分别记录。

保留数据安装同一新APK，两台专用x86_64 AVD实际提供方及可执行映射已核对：API24／Chrome119.0.6045.193、API35／com.android.webview124.0.6367.219，均app_process64。网络组仅API24，严格Private DNS组及后续完整TLS回归仅API35；未重跑全部历史矩阵。

| 本轮实际验收 | 结果与限制 |
| --- | --- |
| API24：系统辅助DNS挂起时关闭无线／数据 | 正确随机DNS名、本包辅助PID与一条绑定先被实际观察；NETWORK_LOST，回调到终态41ms；辅助进程、绑定、工作项、监听及应用FD归零 |
| API24：辅助DNS已结束、TLS读取首块后关闭无线／数据 | NETWORK_LOST，回调到终态1ms；本包真实读取FD正例后归零，未误称此阶段仍有辅助DNS工作 |
| API24：两次离线及恢复 | 离线新ID均NETWORK_UNAVAILABLE；重建后的不同Network上显式新ID完成原Host／SNI、公开虚构授权及三段中文，DNS阶段旧回复仍挂起，辅助PID更新；旧事件无追加 |
| API35：严格Private DNS新请求拒绝 | 实际LinkProperties的active／strict均true，dns-valid、随机dns、IP http三种新请求分别约4／4／3ms为PRIVATE_DNS_UNVERIFIED，无应用DNS／HTTP／辅助工作；不是仅检查Settings值 |
| API35：恢复及TLS回归 | 原值与键存在性精确恢复，实际active／strict清除后首个显式新ID完成原域HTTPS；随后完整TLS／SSE／凭据失败与恢复／错误证书等回归通过 |

网络组从宿主发出切换至终态和资源检查完成分别924／852ms，含系统开关处理与ADB检查，不能与设备回调耗时混用；两组都是蜂窝虚拟网络断开／重建，不是并存网络无缝切换。API24只读组共7个请求，API35严格组共5个请求，所有新组与TLS回归完整账本不变，API24仍24条／2952分、API35仍26条／3198分；每组主应用PID保持。公开虚构凭据准备单列，不读取真实密钥。

PrivateDnsFixture仅允许固定dot.p0-dns.invalid引导名，预置严格配置或非空名称在写入前拒绝；首次写入前保留原值及缺失键，部分写入失败也可恢复。对端只回答固定引导名的A／AAAA为10.0.2.2／无AAAA，可能的本AVD10.0.2.2:853连接经自有P0_DOT_PROBE到宿主既有18515握手停顿端口，不改宿主DNS／防火墙、不新增信任或公网供应商。本轮没有观察到引导查询、853连接或握手；encryptedDnsSupportProven=false。最终拒绝验收以真实严格LinkProperties为正例，未将未发生的DoT步骤计通过，未说明未启动原因。

保留失败与修正：API24首次在正常HTTPS已done后的内核状态读取中ADB非零，终态与资源已保留，当时尚未执行断网；与前轮同类采样问题分别记录，定向读取未再复现，未定因或修复。错误信息改为始终附退出码、固定命令前缀、stdout字节数及有界stderr，不再由非空stdout掩盖命令上下文；读失败仍使检查失败，无自动重试或缺失当零。Private DNS脚本首次漏传观测API要求的requestId，HTTP400发生在修改设置前，已修正；随后严格状态出现但预设的引导／握手正例未出现，保留失败记录并明确验收范围为实际严格配置的新请求拒绝／恢复，移除对未发生TLS过程的通过要求，相关字段仍照实输出。最终两组及完整TLS回归通过，未据此宣布历史API35恢复首请求失败已修复。

主机12项Python检查通过（含优化模式）：新增Private DNS缺失键／空值恢复、两种设置在写入后抛错的恢复、已有严格配置无写入拒绝，并用真实回环UDP验证固定引导名白名单；两个新case的物理serial在任何ADB调用前拒绝。契约／快照、14组账目样例、类型、修改脚本语法与文档链接／差异检查通过。MiniDNS报文算法与辅助进程Java实现未改，不本机重跑其26组或前轮14项完整worker组；对应提交CI仍做三配置独立构建／lint／打包及主机检查，不跑模拟器。

复现见MAINTAINING的“辅助路径网络丢失与严格Private DNS”。结束已核对无线、代理、Private DNS设置与开始一致，无辅助进程、故障链或自身转发，自己的两个AVD与服务均停止、数据保留，18510–18518宿主端口释放；工程／SDK／证书／APK／原始报告均在仓库外，手机与其他设备未操作。尚未覆盖有效DoT、API28、机会模式、动态Private DNS／代理配置、真实供应商／IPv6／VPN、后台／省电或全部Binder竞态，拒绝策略不是正式产品降级决定。下一项整理正式传输维护路线、框架／支持范围及凭据生命周期采纳提案，明确采用前必过项与用户待定取舍，不默认追加同类DNS实验；P0未结束、P1未开始。

## 2026-11-14：主线采纳与P1设计首稿

承接干净main／origin/main `6b2da6a`，基线CI43385248022三组通过。先以`379eb97`提交四份现有文档的采纳提案与两项策略；其CI43571493144首轮两组通过，可选OkHttp组在下载Gradle8.14.3分发包时Connection reset、未进入编译，按日志归因为外部下载连接失败，仅重跑失败组一次后，第二次运行三组最终均通过，未改代码或放宽检查。用户随后确认主线与分层并进入P1设计，以下为确认后的当前状态。

用户本轮确认三项：分级支持优先对有持续更新来源的环境作正式承诺，旧设备继续兼容验证，保留全部目标能力、暂不改minSdk；用户主动调用时不反复系统认证，已发起请求可继续、锁屏不自动新发；以固定Capacitor8.6.0为正式实现起点，分离TS业务与Android存储／凭据／传输，进入P1契约与本地事务设计。已同步AGENTS和用户README，旧“仅为候选”不再是当前框架状态；正式适配／最低支持清单／发布仍分别验收，不把跨端P0宣布为全部通过。

[框架决定](ANDROID_FRAMEWORK_REVIEW.md)保留候选传输与采用门槛：优先评估固定OkHttp＋平台DNS／旧系统私有进程系统解析，MiniDNS保留实验对照，不直接进入正式release。正式模块、凭据目标隔离／版本化密文／恢复与删除轮换、代理／Private DNS动态语义及实际组合均待实现／验收；Keystore可用不等于锁屏策略已生效，后台存活未验证，实验6秒时限不变为产品默认值。

只读核实官方更新线：Chrome119为Android7最后版本，Chrome138为Android8／9最后版本，原始官方链接与提供方关系见框架决定。历史组件能安装／运行不等于持续维护；其他提供方仍须核实，不由Chrome门槛直接提高本应用minSdk或抹去旧组合证据。

新增[P1_LOCAL_DATA_DESIGN](P1_LOCAL_DATA_DESIGN.md)作为独立业务设计载体，首稿包含固定来源、业务不变量、金额／日期／身份区别、命令与原生事务顺序、回执丢失／删除重放／历史／文件恢复、18项虚构保护样例和8组跨仓差异。只读核对电脑固定`7e2bb600e030385398cbf1e2dc9c59d4d6d7a850`能力矩阵、跨端计划及领域／旅中／回款／重规划源码；确认录入Decimal范围小于投影安全整数范围，消费day不是付款日，当前Booking不含时区。新字段／命令／错误状态均为提议，无正式契约版本、Schema、注册API或建表；未改电脑、共享快照或现有规则。

本轮合计新增上述一份设计文档，修改AGENTS、README、ANDROID_FRAMEWORK_REVIEW、PRODUCT_ROADMAP、MAINTAINING与本页六份现有文件，无文件删除，无应用功能增删、依赖／权限／生成配置／领域实现／共享契约／设计快照变化；未在本机生成或安装APK、启动ADB／设备／服务或重跑历史验收。远端CI按其隔离流程构建实验APK，构建不等于运行验收。版本仍0.0.0，无正式发布。

验证范围为官方资料与固定源码交叉核对、文档链接／差异检查和现有契约／14组汇总样例／类型检查；另用现有TS只读函数核算M3两状态、M4及M6的4项金额预期，Python datetime／zoneinfo核对两个日期示例，未增持久测试或实现。草案18项命令／故障保护尚待共同向量与正式实现，未执行真实写入、密钥轮换、锁屏、迁移或新Android行为验收。后续提交的远端CI按其提交另核对，不沿用379eb97结果。API35恢复首请求与ADB采样异常继续未定因，有效DoT、动态配置、真实供应商与正式凭据仍未完成；当前下一项见路线图P1：先收口金额／日期／身份与版本差异，再形成带版本的契约候选、正式事务接口及恢复设计。


## 2026-11-14：P1具体评审样例与只读检查

承接干净main／origin/main `f270fe9`及其CI43572534136三组首轮通过。先只读核对电脑main为`23236a6c46bf5f3c7ca8966250413aa2f4722dfb`；相对首稿固定`7e2bb600e030385398cbf1e2dc9c59d4d6d7a850`为ahead21、27个变更路径，未改变本稿核对的backend领域／路由／旅中回款／版本存储及只读契约。通过GitHub固定提交读取相关源码／blob，未拉取电脑main、改电脑仓库、读取个人数据或更新共享快照。

将差异具体化为[P1设计第7节](P1_LOCAL_DATA_DESIGN.md)及[评审JSON](fixtures/p1-review-cases.json)：6组只读金额、2组时区换算、2组跨日算术和12项源码场景。源码核对发现当前创建去重返回latest；更正后重放旧创建会冲突；删除后在最新版本复用旧ID可走创建路径，而过期版本且无同ID记录会在保存前冲突；票据验证在创建去重前执行。现有版本seq／checkpoint与多次存储commit不等于通用回执、删除记录和因果／原子协议。这些是有条件的源码推导，没有执行电脑路由或宣称复现数据丢失。Pydantic默认忽略额外字段对新增付款日的风险有官方说明，固定Python模型／HTTP行为仍未运行。

用户本轮确认付款日产品规则：与关联行程日分别保存，新建消费默认填手机当前日期且可修改，保存后不随时区／行程调整自动改变；旧记录缺失保持未知。设计明确编辑旧记录不自动补今天，避免制造付款事实。此确认不等于共享字段／格式、旧端能力协商或日期写入实现已完成。

新增`scripts/check-p1-review.mjs`与上述JSON；修改package.json及CI加入`pnpm check:p1-review`，同步P1_LOCAL_DATA_DESIGN、MAINTAINING、PRODUCT_ROADMAP及本页四份文档，共新增2文件、修改6文件，无删除。开发工具新增只读评审资料核算／关联检查及CI入口；应用业务功能无新增／修改／删除，无运行时依赖、锁文件、权限、生成器、领域实现、vendor契约／设计变化。未启动ADB、设备、SDK或本机服务，未生成／安装APK或触碰实验库；版本仍0.0.0，未发布。

本轮本地检查范围：新入口核算6组现有只读投影、2组时区换算和2组跨日整数算术，并检查12项源码场景结构／设计引用；9份仓库外损坏副本分别因错误金额、错误日期、丢失偏移、重复ID、无效设计／来源引用、缺少未决项、伪造联合接受／契约版本被拒绝，临时文件清除。固定快照／14组既有汇总／类型、脚本语法及文档链接／差异检查按本轮实际结果记录。检查器不联网验证blob或执行JSON中的业务步骤；明确输出联合评审pending、Python后端未执行、移动写入执行0。18项保护场景与12项源码场景均未因此成为正式写入／故障验收。

当前已准备好供两端共同核对的具体资料，但尚无电脑侧接受或Python参考执行结果，不把单端只读检查写成共同契约完成。下一项按第7节四组要求核对金额／日期／身份／版本与重放／恢复，记录双方固定提交及接受／修改／待定项，再固化带版本的写入契约候选、正式事务接口与恢复状态机；未授权对外发消息或默认电脑立即升级。新提交CI仍须按该提交核对，不能沿用f270fe9；正式网络、凭据、迁移和发布门槛不变。

## 2026-11-15：电脑侧评审接收、移动侧复核及产品取舍

承接干净main／origin/main `577a41b`；上一提交CI43573947016三组通过。本轮按用户提供的固定电脑评审`81ff51574b13f3b7e54ea1e75f8ebd7a04630404`只读核对报告、测试、样例副本及隔离夹具／checkpointer。相对电脑23236a6仅一个提交、8个资料／测试路径变化，生产源码与0.1.0未改。未拉取电脑main、导入相邻代码、操作电脑工作区或默认升级vendor。

电脑样例副本与移动577a41b原资料逐字节一致，Git blob均1f09ea8e0d7859a2d3f865447da542e34a2c2238；评审与测试blob分别4594f887d252a5ecd09284e7eb2f0e0909a0970e、ae5d0641899c8396f6f0591c611930ecfe662efd。移动侧以AST静态展开19个测试函数为39项，未执行Python测试；电脑报告39项隔离核对及既有26项专项通过，移动侧接受其固定基线报告证据并审读测试边界，不记成本地复跑。该电脑提交带skip ci，查询无对应Actions运行，不声明其完整CI通过。

[P1设计](P1_LOCAL_DATA_DESIGN.md)第8节新增S01–S12移动侧复核：接受金额读写边界、原操作回执与当前头分开、删除保护、旧版本血缘和单一权威事务／投影恢复方向。电脑有条件的HTTP复现把S06删除后当前头重放、S12未知付款日／版本字段静默丢弃从推断推进为电脑侧现状报告；S08仅模拟票据查询不可用，S10是同文件不同SQLite连接的四个调用点OSError注入，不泛化为物理附件丢失、真实磁盘满／断电或Android恢复通过。新的目标契约与恢复实现仍不存在。

用户2026-11-15已确认三项产品规则：正式新写入首版明确CNY，其他币种另评审且旧缺失币种保持未知；新建消费允许主动选择付款日未知，原有当天默认／可改／保存后稳定与旧未知不补今天保持；明确时区的新预约按真实经过分钟，旧记录保留原钟面规则、不批量重算。设计第3／9节已同步，无需重问。候选进一步列明正整分／记录上限、paid_on与缺省／null、能力不兼容暂停交换、回执与删除、旧版本映射和权威提交／恢复断点，未分配契约版本、注册API或建表。

本轮仅修改P1_LOCAL_DATA_DESIGN、PRODUCT_ROADMAP、MAINTAINING与本页四份既有文档，无文件新增／删除、应用或开发工具功能增删改、依赖／锁文件／权限／领域实现／vendor变化；原评审JSON及工具保持不变，以保留被电脑逐字节验证的历史输入。其pending与未执行字段不代表今天仍未收到电脑反馈，当前复核状态以设计第8／9节为准。未启动ADB、设备、SDK或本机服务，未构建／安装APK或修改真实数据，版本仍0.0.0，未发布。

验证包括固定提交／输入字节／Git blob、测试AST／夹具及断言复核，既有契约／14组汇总／P1只读资料／类型和文档链接／差异检查。另用Python datetime／zoneinfo与Node v26.3.0／ICU78.3／tz2026b独立核算3组跨夏令时真实120分钟示例，Python验证1个不存在当地时刻的两种fold均无法UTC往返；仅为纯日期候选计算，未执行预约写入、跨端新协议、恢复／迁移或真实供应商验证。新提交的远端CI仍按其提交另核对。

当前双方已完成一轮现状评审与方向对照；字段／格式／协商和恢复候选未共同定版，0.1.0保持原样。下一项按设计第9节补严格金额文本、真实日历／明确未知／夏令时共同向量，固定命令／回执／能力响应和旧版本映射、收口恢复状态机；共同确认后才在权威仓库分配新版本并显式导入，不据本次接收直接进入正式写入／迁移／发布。


## 2026-11-15：值片段候选与双语言对照

承接干净main／origin/main `f0e8dd6`，上一提交CI43681592454通过。本轮沿P1第9节把候选具体化为设计第10节与独立p1-value-cases.json；不更新电脑工作区或vendor0.1.0，不把候选分配正式共享版本。原577a41b评审JSON仍保持逐字节不变，电脑81ff515的39项现状证据及其未复跑边界不变。

新增`prototypes/p1-values/values.mjs`、`scripts/check-p1-values.mjs`、`scripts/check-p1-values.py`和`docs/internal/fixtures/p1-value-cases.json`四文件；修改.gitattributes、package.json、CI及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页七文件，无删除；评审样例显式保持LF以便跨仓字节核对，不定义命令规范化协议。开发能力新增纯值片段／回执视图候选、Node／Python独立适配与CI只读对照；应用业务功能无增删改，无新第三方依赖／锁文件／权限／生成器／领域实现／共享快照变化。生成器仅复制既有android-runtime及显式可选探针来源，新原型不进入APK；本机未启动ADB、设备、SDK或服务，也未构建／安装APK、写库、迁移或发布。版本仍0.0.0。

74项候选由18个金额文本、12个已解码CNY金额、16个付款日、16个明确时区真实经过分钟预约及12个已提交回执视图组成；23值接受／51值按预期拒绝。Node以独立预期核对并冻结输入，Python标准库独立计算同资料，两者结果一致且输入不改。覆盖金额文本精确整分、bool拒绝、编辑省略与null、闰年／非法日历、夏令时两种重复实例／不存在时刻、原提交修订与当前头分离。当前不是完整消费／预约命令，其他原有业务字段及预算／回款／记录数／历史保护继续待完整契约承接。

本机执行环境为Node v26.3.0／ICU78.3／tz2026b、Python3.14.10／系统tz2026f，Python没有导入电脑业务或Pydantic；不冒充电脑Python3.13.13参考后端、Android原生或持久回执执行。检查器明确报告联合契约pending、Android／存储未执行及raw_json_decoder_verified=false。另将省略误当null、夏令时错误结束时刻、原回执误换当前头、重复ID、空资料、伪造联合接受／契约版本七份副本逐项拒绝，并验证缺失Python直接失败、不跳过；临时副本清除，无新增常驻测试框架。

已核算的对象从解码后的值开始；原始JSON精度保真、重复键、规范化字节／Unicode及摘要仍未设计完成，不能用74项通过证明网络包安全或完整写入契约通过。money_text的新严格语法与旧Decimal兼容读分开，money_value按整数值语义处理100.0且明确排除bool；paid_on缺省和null不合并。回执视图只验证表达，不查询真实操作、不实现删除恢复；预约片段只用于已明确解析的新记录，旧时区未知／钟面记录不强制转换。

验证为74项双语言候选及上述八组拒绝检查、既有契约／14项汇总／原P1评审／类型、脚本语法与文档链接／差异检查；远端CI按新提交另核对。下一项按设计第10节将新目标候选交电脑侧复核，并收口保真解码／重复键、共同字节向量、完整命令／能力响应，再推进ID／旧版本映射和权威事务／恢复；共享版本仅在权威仓库共同确认后分配，本轮不进入正式写入。


## 2026-11-15：第二轮候选反馈与预约边界修复

承接干净main／origin/main `3100d32`，其CI43683202545三组通过。用户提供电脑`d0cd2b64d60885f2c35fa829dd988620c976d2e9`评审第8节；相对81ff515仅两次资料／测试提交、10个相关路径变化，无生产实现／0.1.0变化。移动侧审读独立参考与显式测试，三份电脑固定证据与移动3100d32逐字节一致；AST静态展开5个函数为80项，未在本机执行电脑pytest。电脑报告原74项三路结果一致，80项包含成功复现旧缺口；对应提交未查到Actions运行，不声明完整CI通过。

本机修改前独立复现：E01 Node输出+010000年UTC终点但当地仍9999年，Python拒绝；E02 Node返回resolution、Python抛未归类OverflowError；E03小写时区被Intl接受、ZoneInfo拒绝。已修正Node起止UTC／当地范围并校验era，Python统一转换异常为booking_range；E01／E02现在两适配均明确拒绝，不让异常逃出批处理。E03采用同一精确拼写候选词表，区分大小写、不隐式转换别名。词表5个ID仅用于隔离样例，不是正式产品支持清单或全量IANA命名表，不缩减其他地区与旧预约目标。

新增`docs/internal/fixtures/p1-value-boundaries.json`与`prototypes/p1-values/time-zone-ids.json`两文件；修改Node值原型、Node／Python检查器、.gitattributes及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页八文件，无删除。开发工具行为调整为范围错误明确拒绝、登记名称一致匹配，以及默认检查原74＋新增14；回执／日期／金额原预期保持。应用业务功能无增删改，无依赖／锁文件／权限／生成器／领域实现或vendor变化；原74及首轮评审JSON保持原字节，JSON资产固定LF。未启动设备、ADB、SDK或服务，未生成／安装APK、改真实库、迁移或发布，版本仍0.0.0。

修订后88项对照一致、29值接受／59拒绝，覆盖电脑E01–E06、补充大小写／别名、UTC与当地的上下限及合法年份两端；输入不变。原74、补充14分别计数，Node／Python使用同一词表并校验。另有6份改坏边界预期被拒绝，临时副本清除。运行环境仍Node v26.3.0／ICU78.3／tz2026b、Python3.14.10／系统tz2026f，不冒充电脑Python3.13.13复跑新修订；新Node文件需携带同目录JSON，Python入口可显式传词表路径，主检查器已传参。

电脑RAW1小数舍入、RAW2重复键复现作为正式定版前的未决边界接收，本轮没有实现原始解码器或规范化字节；raw_json_decoder_verified=false、联合契约pending、Android／存储未执行保持。固定源字节／测试断言复核、88项及上述6项拒绝检查、既有契约／14组汇总／P1评审／类型、脚本语法、链接和差异按本轮验证记录；新提交CI仍单独核对。旧电脑80项刻画固定缺口，不能复制成必须保留错误的当前目标门禁。

当前第11节已经给出移动侧修正与E03策略回复。下一项先交电脑侧复核本轮完整文件组与14项新增目标，再收口正式全量命名／别名和原始JSON保真解码／重复键／字节规范化，随后推进完整命令、ID／历史映射和恢复。没有新的产品取舍需要用户决定；不重复询问既定规则，不分配正式契约版本或更新vendor。

## 2026-11-15：第三轮复核接收与原始JSON宿主候选

承接干净main／origin/main `0ff3913`，其CI43690697602三组通过。用户提供电脑`d30e41b236a9876280c69b6bccf4c96ea86b5243`评审第9节；相对d0cd2b6仅一次提交、12个相关资料／测试路径变化。四份电脑固定副本与移动原文逐字节一致；审读新测试，静态展开96项，电脑报告新96＋旧80共176项通过及修订88项三路一致，本机未跑电脑pytest。限定接受E01／E02关闭与E03原型策略，完整命名／版本仍待定，无新增产品问题。来源、摘要和接受范围见P1_LOCAL_DATA_DESIGN第12节。

新增`prototypes/p1-json/decode.mjs`、`scripts/check-p1-json.mjs`、`scripts/check-p1-json.py`与`docs/internal/fixtures/p1-json-cases.json`四文件；修改根package.json／pnpm-lock.yaml、CI、THIRD_PARTY_NOTICES及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页八文件，无删除。功能新增宿主原始UTF-8／严格JSON、解码后逐对象重复键拒绝、数字词形保留及精确CNY金额片段对照；应用业务功能无增删改。jsonc-parser3.3.1为固定MIT开发依赖；保留位置的语法树搭配全部错误拒绝，独立Python采用标准库json／Decimal，不导入电脑业务，不自写JSON语法解析器。

58项由两适配独立核对，17接受／41按预期拒绝、输入不改；覆盖RAW1型舍入、RAW2型覆盖、同值／嵌套／转义同名、Unicode代理项、非法UTF-8、JSONC容错、金额小数／指数的整数值正例，以及普通小数／数组／省略与null的保真表达。通用数字不全局强制整数；诊断树保留源码对象顺序，不是规范化字节或命令摘要。本机Node v26.3.0、Python3.14.10，不冒充电脑独立参考或原生验收。6份改坏资料与缺解释器均失败、不跳过，临时资料已删除；新资料desktop_joint_review=pending、共享版本null，canonical_bytes_verified=false、Android／存储false。

实际验证：58项新候选、原88项值候选、契约／14组汇总／原P1评审／类型、冻结锁安装、根依赖审计、脚本语法、42个本地文档链接及差异检查。审计无已知漏洞；历史三份评审／值JSON和词表保持字节不变，vendor、领域、Android来源及生成器无变化。生成器只取既有android-runtime和显式可选探针，新原型／依赖不进入APK。没有启动ADB、设备、SDK或服务，没有本机构建／安装、写库、迁移、真实联网／凭据或发布；版本仍0.0.0。本轮远端CI须对应新提交另核对，不能用旧CI代替。

下一项按设计第13节与路线P1，将完整原始候选文件组交电脑独立复核，随后共同确定完整命令数字域、Unicode／缺省／null、规范化字节和摘要；正式体积／深度／数字长度限制仍未验收。完整时区目录／能力响应、ID／旧版本映射、权威事务／恢复继续待定；不分配共享版本、更新0.1.0或进入正式写入。用户无需重跑人工测试或重答既定产品选择。

## 2026-11-16：原始输入评审接收与完整命令语义草案

承接干净main／origin/main `6ab3a38`，其CI43693030503三组通过。用户提供电脑`12a25a796fbcf17ed3a658fcd89cad7105e9e470`第10节；相对d30e41b仅一次提交、10个资料／隔离测试路径。三份电脑证据与本仓58项／Node原型／Python参考逐字节一致，设计／入口／锁文件blob也匹配。审读独立token reader与断言，AST静态展开5个函数为80项，电脑报告三路一致及指定电脑Python3.13.13运行原入口；本机未跑其pytest，不混算旧值176项。接受既有58项与当前宿主方案，资源、正式字符／数字域、完整命令、字节及原生仍待定，详见设计第14节。

新增`docs/internal/fixtures/p1-json-boundaries.json`一文件；修改`scripts/check-p1-json.mjs`及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页五文件，无删除。开发检查功能增加电脑17项补充输入的独立预期，以及默认两份资料／75项核对、跨资料ID唯一与分文件Python比较；指定PATH仍只跑一份。新容器有pending元数据，不据此改写原58项接受结论或分配共享版本；原始解码实现保持不变。应用业务功能无增删改，无新依赖／锁文件／权限／Android／vendor变化，版本仍0.0.0。

设计第15节新增完整命令语义技术提案：按固定源码静态核对ExpenseInput10字段＋创建request_id、AdjustmentInput5字段、Booking4字段及进度目标，保留预算结算、票据、关联与预约旧含义；allow_shared_receipts虽不存进Expense仍参与意图。区分显式创建／部分更正、省略／null／空数组、请求／调用上下文／回执，说明先查回执再验证当前业务关联。Q01–Q12列出金额数值等价、字段重排、控制条件、基线、Unicode／空白及原回执的待实现预期，**未执行，不算75项完整命令通过**。旧strip、票据保序／去重、旧未知币种纠错及历史兼容待共同核对，不以新约束删除旧能力；完整资源／能力响应及字节／摘要继续待定。

实际检查：75项原始输入25接受／50拒绝，两个指定单文件58／17分别通过；88项值候选、固定契约、14组汇总、原P1资料与类型通过。环境Node v26.3.0、Python3.14.10，未冒充电脑环境。6份变坏资料（Unicode／重复／语法拒绝顺序、RAW1、跨资料重复ID及伪造版本）均失败，临时副本已删除；七份固定资料／实现／锁文件逐字节不变。另核对脚本语法、文档链接和差异；本轮CI对应新提交单独核对。没有启动设备、ADB、SDK或服务，没有本机构建／安装、真实库／迁移、正式网络／凭据或发布。

下一项按设计第15节与移动路线P1，请电脑审阅字段去向、创建／部分更正和Q01–Q12，明确旧title.strip、票据顺序／重复及未知旧值适配；然后形成完整命令／能力与资源配置的机器向量，验证预算拒绝路径，再决定规范化／摘要字节。全量时区、ID／历史映射、事务／恢复门槛保持，无新产品选择需立即回答；当前无需用户操作手机。

## 2026-11-16：第五轮语义评审、产品细化与纯补丁候选

承接干净main／origin/main `30077db`，其CI43887901257三组通过。用户提供电脑`e060bab3d13d62e666624cf7500adc051df389c1`第11节；相对12a25a7仅一次提交、6个资料／隔离测试路径。设计blob与电脑记录匹配，审读显式探针并静态展开20个函数为36项（22个比较／14个旧行为）；本机未执行电脑pytest，固定环境报告与当前候选执行分别记录。接受字段覆盖和Q例方向，补部分更正的联合校验、文本合法性和独立回执查询；旧PUT覆盖、票据共享开关、预约clear及strip差异仍作为旧行为，不冒充新协议已修复。来源和边界见设计第16节。

用户本轮确认：业务内容无变化时不新增业务修订，但保留操作回执；旧未知币种允许保持未知纠正金额、留下更正历史并隔离CNY统计，可另行明确确认CNY。新建首版CNY不变，不据此开放已知外币换汇。无变化也要验证权限／基线，持久化处理回执；字段及操作索引／出站事实仍待设计，未因产品确认直接建表。

新增`prototypes/p1-patch/expense.mjs`、`scripts/check-p1-patch.mjs`、`scripts/check-p1-patch.py`、`docs/internal/fixtures/p1-patch-cases.json`四文件；修改根package.json、CI及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页六文件，无删除。开发能力新增纯已解码消费补丁候选、独立Node／Python计划对照与CI入口；应用业务功能无增删改，无新依赖／锁文件／权限／Android／生成器／vendor变化，版本仍0.0.0。

70项、33接受／37拒绝，覆盖候选实体预算联合约束、含pending的逐类回款上限、票据清空／新增共享／顺序／重复／不可用、日期、无变化及仅控制计划、旧币种缺失／null／明确CNY、文本标量／C0／C1／BOM候选、旧文本不改及未知字段。Node冻结展开输入、Python深复制独立计算，完整候选输出与独立手写预期差异展开值一致，输入不改；100个非BMP标题／1000个非BMP备注可用。环境Node v26.3.0、Python3.14.10，无电脑业务导入。

执行仅为可信虚构基线与关联资料上的计划，不是正式信封、完整原始解码、鉴权、基线查锁或事务；原金额须已无损且在范围内，任意旧超界／损坏导入未验。输出required-not-persisted明确回执只为计划，raw_command_decoder／resource_limits／canonical_bytes／durable_receipts／storage／Android均false。文本表是新候选，不批量改旧文本；查询与分域具体预算仅为提案，未做拒绝不写库或原生并发保证。

实际验证：70项、原88项值／75项原始输入、固定契约、14组汇总、原P1资料、类型、脚本语法、46个文档本地链接和差异检查通过。6份坏资料（无变化修订、旧未知误计CNY、默认覆盖、伪造无回执预期、重复ID、伪造存储通过）及缺Python均拒绝，临时副本删除。五份历史评审／值／原始JSON与根锁文件保持原字节，既有实现及共享快照不变。未启动设备、ADB、SDK或服务，未本机构建／安装、改真实库、迁移、正式网络／凭据实现或发布；新CI须对应本次提交另核对。

下一项按设计第17节及移动路线P1，请电脑独立复核补丁／文本、票据仅新增引用查询及两项产品细化；然后将有界控制命令与独立回执查询接到原始输入，补齐完整创建／回款／预约等机器向量与能力响应。资源拒绝、认证绑定及持久回执／事务须分别验证，再决定规范化字节／摘要；全量时区、ID／历史和T1／F1恢复门槛保持。当前无需用户操作手机。

## 2026-11-17：关闭补丁复核，完成有界原始入口与共享调度

承接干净main／origin/main `eee6cda`，其CI43894821989三组通过。用户提供电脑`5b221ae188d715afef0f31ed79eed9dbcc44ff3d`第12节，相对e060bab仅一次提交、11个资料／固定副本／隔离测试路径；报告中的本仓设计／四份来源blob匹配固定提交。审读显式参考与断言，电脑报告98项（4源、清单、原入口、70＋22）通过；本机未跑其pytest。接受70项及有限文本／查询方向，关闭纯补丁设计差异。22项新增边界保留为电脑固定证据，不再为重复往返另抄同类资料；短指数展开、计数定义和总调度要求进入实际实现。详见设计第18节。

用户提醒避免无限审查，未禁止电脑协作。已将推进方式写入路线：默认完成本地可验证实现，旧结论直接引用；只对新增共享语义／版本或真实跨端失败定点协调，完整候选冻结后统一核对，不以“把同一批样例再送一轮”作为默认门槛。原共同定版／vendor／正式采用与发布门槛仍在，没有擅自升级共享协议。

新增prototypes/p1-boundary下input.mjs／commands.mjs／scheduler.mjs／profile.json、scripts/check-p1-boundary.mjs、docs/internal/fixtures/p1-boundary-cases.json六文件；修改.gitattributes、根package.json、CI、原补丁模块及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页八文件，无删除。开发能力新增有界原始消费创建／更正信封、独立回执／能力查询、前置数值范围判定和单JS运行时共享总队列。补丁模块仅新增字段校验导出，原evaluate语义／70项预期不变；无新依赖／锁文件／权限／Android／生成器／vendor变化，应用业务功能无增删改，版本仍0.0.0。

本机Node v26.3.0实际104项：55个固定原始输入、42个组合流程、7个确定性调度。控制32KiB／查询8KiB、深度16、token2048、字符串4096标量／数字64词形在递归解析／数值展开前守卫，恰好与多1均测；1e1000000000等先按数值域拒绝，不构造巨大幂／比值。支持完整expense.create／expense.patch与独立receipt.lookup／capabilities.query，整数词形等价、未知字段拒绝、创建显式CNY／付款日、旧未知金额更正、无变化计划和联合约束接通。原始意图深冻结，结构比较不是规范化字节／摘要。

默认Boundary实例共用一池：全局4运行／32等待、每作用域1运行／16等待，查询与授权hook都占同一总预算；队首被占用作用域不阻其他可运行项。排队取消释放队位；运行取消等实际settle才释放槽，即使worker忽略signal也不提前启动下一项，异常释放且不吞错误。测试以手动Promise控制，不运行压力实验、不声称跨JS隔离域／进程或Android真实取消；入口限速及其他宿主工作不在当前证明范围。

组合适配为可信虚构权限／内存读取，失败零派发与commit陷阱未触达为spy证据，不是SQLite拒绝不写库或持久回执。原提交查询先于新操作快照／基线，已删实体与头前进不使模型重放再写；权限拒绝先于存在性查询，独立旧键查询不重传旧业务payload，未收敛读取保留unknown。所有成功写操作仍返回uncommitted-plan／required-not-persisted；真实认证、数据库事务／重启／恢复、Android与字节规范均false。没有将模拟回执当成真实提交保证。

除104项外，原88项值／75项原始输入／70项补丁、契约／14组汇总／原P1资料／类型、冻结安装、脚本语法、53个本地文档链接及差异检查通过。六份历史JSON与根锁文件逐字节不变，新JSON固定LF；没有重跑历史模拟器或对端生产验收。本机未启动设备、ADB、SDK或服务，未构建／安装、读写真实库、迁移、真实凭据／供应商或发布；新提交CI单独核对。

下一项按设计第19节与路线P1直接补回款、预约／进度及其能力，不等待重复审查这104项；完整候选冻结时合并跨仓核对，有真实语义分歧则提前协调。之后用全虚构隔离SQLite验证业务／回执／outbox原子性、无变化回执与提交后响应丢失／恢复，再收口字节／摘要、ID／历史和正式原生门槛。用户本轮无需转交同一批样例或操作手机。

## 2026-11-17：四族有界命令与真实临时SQLite事务

承接干净main／origin/main `107db2b`，其CI43994137399三组通过。按第19节下一项直接实现回款／预约／进度及隔离SQLite，没有新增机械送审前置。新增families.mjs、p1-family-cases.json、check-p1-families.mjs、p1-store/sqlite.mjs与check-p1-store.mjs五文件；修改原commands.mjs、根package.json、CI及P1_LOCAL_DATA_DESIGN／MAINTAINING／PRODUCT_ROADMAP／本页七文件，无删除。功能新增四族11种控制命令／能力与独立宿主事务实验，原消费／查询／总调度行为保持；应用业务功能无增删改，无新npm依赖／锁文件／vendor／生成器／Android权限变化。版本仍0.0.0。

四族46项：19接受／27拒绝，接受例另核对内存回执视图的effect／result_revision先查。包括回款同种含pending限额、编辑排除本条旧金额、到账同实体、旧未知币种保留与新关联CNY一致性；消费有回款不可删、墓碑阻止新建复活；预约明确时区经过分钟、日历／解析依据、两次重复实例／不存在时刻、旧钟面／备注保护和clear保留活动时钟；进度枚举／规划起点／同值不刷新审计。能力明确列出五项fixture-only时区，不把候选词表当全球范围。完整恢复、任意旧异常数据及其他LOCAL／MIXED目标仍未完成。

真实临时SQLite23项通过，使用Node内置DatabaseSync，无新依赖；根宿主最低版本改为Node22.16，POSIX／WSL运行子进程退出证据，原生Windows不静默跳过。Node接口为宿主实验选择，不是正式Android存储采用，Android／WebView最低版本政策不变。只在系统tmp新建有PURPOSE及fixture_*身份标记的目录，缺库／错误标记／格式拒绝，不初始化空库覆盖旧文件；结束清理自己创建的数据库／WAL／SHM目录，未提交任何数据库或旅行数据。

存储流程在BEGIN IMMEDIATE同一连接内先查回执，再重读基线／快照并复用计划，变化才更新业务头／插不可变历史／墓碑，回执和outbox同事务提交。no_change不增业务修订或刷新实体审计时间，但持久化处理回执及仅操作出站事实，result_revision引用核对过的头。新记录创建时间／更新及进度变化时间提交时赋一次；付款日不取审计时间补造。独立查询只SELECT回执投影，不读旧payload；争锁期间返回unknown，取得收敛读取点后才报告该时点查无。

实际证据含四个提交前故障点全逻辑行回滚、提交后响应丢失关闭重开查回／同键不重复、原创建删除后重放不复活、同ID重新创建被墓碑阻止、两个SQLite连接争锁及重试、无变化回执、进度时刻、预约落盘／clear、旧未知金额重开保留、原历史不改，以及测试子进程对自身于commit前／后SIGKILL后分别整笔未提交／已提交。新格式／资源／虚构权限拒绝发生在SQL BEGIN前，total_changes及所有逻辑行保持。仅此宿主单分支临时库得到真实事务证据；真实认证、Android、跨JS调度接库、掉电／磁盘满、附件联合事务和真实迁移仍未验，正式采用false。

本机Node v26.3.0／SQLite3.53.1，预约宿主tz2026b；Node22在新提交CI另验。本轮46／23及旧104／88／75／70、契约／14组汇总／原P1资料／类型、冻结安装、脚本语法、59个本地文档链接和差异检查通过；七份历史JSON及根锁文件逐字节不变。没有操作设备、ADB、SDK、真实供应商／凭据、真实库、迁移或发布。原CandidateBoundary仍未提交，旧false标志不改写为全局通过；存储实验的true只描述已执行临时库范围。

下一项按设计第20节及路线P1补显式恢复、旧ID／历史映射与字节／摘要候选，整理完整候选的一次统一跨端验收，再进入正式原生模块门槛。T1／F1剩余故障类型、全量时区、真实身份和全部目标能力保留；本轮无需用户操作手机或逐组转交样例。

## 2026-11-17：显式恢复与虚构旧历史初次映射

承接干净main／origin/main `72a3b57`，CI44009311544三组通过。按设计第20节直接完成下一段宿主验证，无机械送审前置。新增restoration.mjs、p1-store/legacy.mjs及check-p1-history.mjs三文件；修改commands.mjs／sqlite.mjs、根package.json／CI及四份内部入口文档八文件，无文件或功能删除。新增消费／回款恢复、生命周期记录、带类型旧版本／来源血缘映射和初次导入；宿主能力响应现13种命令。应用正式业务仍未实现；无npm依赖、锁文件、vendor、Android权限或生成器变化，版本0.0.0。

60项新检查通过：恢复只用新操作ID、当前基线、同范围来源修订及明确删除事实，不覆盖现存实体。金额／币种／付款日等来源事实保持，关联修复须显式提交并重验当前活动／行程日／预算／票据可用共享和同种回款含pending上限。票据共享占用从当前消费计算；旧创建重试和旧恢复重试均不因后续删除重新写入。缺失币种／付款日与null不合并，不补今天／CNY；旧未更正文本不trim。超界金额与已知外币仍保留历史，恢复明确拒绝，正式兼容修复路径待补，未删产品目标。

临时库格式2／PURPOSE v2新增生命周期、历史映射和来源批次表，旧实验格式拒绝，不自动迁移／清空。墓碑保留ID占用及当前删除／恢复指针，完整旧删除／恢复以追加事件与不可变修订保留；业务、事件、回执和outbox同事务。四个提交前异常注入回滚全部逻辑行；提交后响应丢失重开可重放原回执，重复删除／恢复不丢历史。原23项进程退出检查继续通过，新60项不冒充独立SIGKILL／断电／磁盘满证据。

历史输入只允许已解码的TravelFlow-AI-fixture完整快照，一次最多64版本／32层／100000节点／1MiB。来源dataset／travel／branch／version按带类型键精确映射，数字与字符串不合并，旧实体大小写／空格／NFC差异保持；原版本JSON／来源信息／审计和缺失字段保存。只采显式父引用，缺省unknown、不可用unresolved，不按时间或数组补血缘。仅全空、无业务／预算／操作事实的初始目标允许采用；相同批次重开重试或本地更正后重试只回原映射，不回退当前头，变更／追加版本冲突。导入不伪造旧操作回执／outbox／墓碑；实际旧文件适配、原有删除证据导入、任意损坏值、物理附件和增量／迁移仍未实现。

本机Node v26.3.0／SQLite3.53.1，新60及旧23／46／104／88／75／70、契约／14组汇总／原P1资料与类型检查通过；脚本语法、冻结安装、62个本地文档链接与差异检查通过，CI在新提交另验Node22。八份冻结JSON与根锁文件不变。全部测试库由脚本新建并清理，无设备／ADB／SDK／真实服务或个人数据操作。真实身份／Android采用／异步调度接库／共享协议仍未通过，不把临时库结果升级为正式写入／迁移或发布。

下一项按设计第21节与路线P1收口规范化字节／摘要，整理完整候选的一次跨端验收；全量时区、真实历史适配及T1／F1门槛分别保留。本轮无需用户操作手机或逐组转交样例。

## 2026-11-17：命令规范化字节／摘要候选与统一验收入口

承接干净main／origin/main `01d97c8`，CI44032415192三组通过。按设计第21节下一项完成独立宿主编码候选：新增p1-canonical/intent.mjs、p1-canonical-cases.json与Node／Python两检查器四文件；修改根package.json／CI和四份内部文档六文件，无文件或功能删除。功能新增已校验命令意图的固定JSON／UTF-8／SHA-256输出，未改应用、原命令、回执事务或临时库格式2；无新依赖、锁文件、vendor或Android权限变化，版本仍0.0.0。

内部profile p1-host-intent-c14n-1只处理当前整数域，先复用原有界控制／查询校验，再编码含profile／channel／完整intent的文档。对象递归按UTF-16码元排序，数组和字符串原样保留，精确等价整数词形统一；缺省／null、票据顺序、控制许可、所有身份／基线、预约解析依据及恢复来源保持区别。不添加当前状态、token或派生时刻。输出无结构空白／BOM／尾换行，UTF-8上限65536字节，SHA-256作用于完整文档字节；不声称通用浮点、历史／坐标或完整JCS／I-JSON支持。摘要不替代来源认证／完整意图核对；现有存储仍比较完整结构，原canonical_bytes=false不被改写为已采用。

103个固定向量（85接受／18拒绝）及18组语义关系通过，涵盖13命令／receipt.lookup、键重排／转义、整数词形／近整数拒绝、所有重要意图差异、UTF-16与Python码点序差异、数字样式键、C0／非BMP／非字符、巨指数、坏编码／重复键／语法。三条手写排序／零锚点另核对；6项Node格式集成拒绝近整数／bool／未知observed_head／同值重复／超长数字／未知channel。每项有固定文本／hex／SHA，不在运行时重新生成预期。

Node先验证原始命令等于夹具显式validated_intent，Python标准库独立编码该投影；原语向量复用原严格raw参考。没有重实现电脑命令校验，不能以这103项宣称电脑Python后端或Android已接受请求。Python仅固定资料参考，不是生产资源拒绝入口；存储指纹、真实身份、同步和正式迁移均false。预约basis使用固定fixture-tzdb文本，不依赖当前宿主tzdb，也不冒充该业务请求已可提交。

本机Node v26.3.0／Python3.14.10，新增检查通过；旧60／23／46／104／88／75／70、契约／14组汇总／原P1资料、类型、冻结安装、脚本语法、66个本地文档链接和差异检查通过。六种改坏资料及缺Python拒绝检查通过，临时副本已清理；CI在新提交另验Node22。旧八份JSON、资源profile、时区目录、根锁文件及原事务实现保持原字节。没有设备／ADB／SDK、真实文件／数据库／供应商操作。统一跨端验收清单已整理在设计第22节，尚未对外发送或收到本批电脑侧验收；不为每组向量再开往返审查。

下一项按第22节固定双方提交，完成当前有界候选的一次统一对照，记录接受／差异与执行边界；共享版本在共同确认后才由权威仓库分配并显式导入。全量IANA、真实历史文件适配、T1／F1及正式原生门槛保留。当前无需操作手机，无正式发布。

## 2026-11-21 统一验收已收口，虚构桌面源文件读入已验证

电脑 `a8baa69` 回报对移动 `dcba911` 的12个入口全部通过，独立实现的103例及18组关系与固定预期一致。移动侧核对两个blob和电脑独立断言，接收已有结果。双方接受编码候选，正式版本分配和存储采用仍待验。[固定评审](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/a8baa69545de5410a4993eee3d4b245e067f5c88/docs/internal/P1_CROSS_REPO_REVIEW.md#L472)

本轮新增桌面源记录读取器与临时文件验收脚本，更新检查入口、CI及维护文档。实际覆盖只读虚构源文件到移动临时SQLite的导入、源文本精确保留、局部解释、拒绝路径，以及本地更正后重开重试。测试资产均由脚本自建并清理。实现范围与限制见[设计第23节](P1_LOCAL_DATA_DESIGN.md#23-固定批次联合结论与桌面源记录读取)。

## 2026-11-21 IANA全目录与规则版本差异

宿主命令可选用固定2026f目录，通过精确名称或链接创建预约。新增目录快照、生成器、能力检查与Node／Python验收，将新目录接入booking.set和能力查询。本机真实规则对照发现，2026年11月2日同一UTC时刻有11个名称（含别名）的偏移不同。SQLite验证了回拨时段的真实经过分钟、别名与解析依据的保存，以及版本变化后原操作重放和备注更正。[证据与覆盖范围](P1_LOCAL_DATA_DESIGN.md#24-iana名称目录与预约解析版本)

## 2026-11-21 API 35原生提交与票据故障恢复

隔离模拟器中，独立原生测试包完成七个进程终止位置及一个SQLite页上限错误的重开验证。已核对完整账目、历史、操作回执、待发送记录及历史票据字节。构建与设备复验使用不同入口，原P0包和手机均未参与。[原生证据](P1_LOCAL_DATA_DESIGN.md#25-android原生事务与历史票据恢复) · [复验方法](MAINTAINING.md#p1原生事务与票据恢复复验)

## 2026-11-21 两进程争锁与待核实操作恢复

API 35模拟器上，调用方普通读取看见零条回执，尝试取得写锁核实时得到忙。调用方保留请求直至核对到其原ID和意图对应的回执。写方提交／回滚后调用方进程均被终止；重开分别验证只确认原提交／使用原请求重提，均只有一个有效更正。原八项进程中断和页上限场景也通过同一验收入口。[宿主与设备实测边界](P1_LOCAL_DATA_DESIGN.md#26-写锁期间的回执查询与调用方恢复)

## 2026-11-21 第二张票据写入失败与恢复

API 35虚构账本已验证打开暂存文件、部分写入、改名及目录同步四个失败位置，分别检查文件残留、旧修订与历史票据字节、同操作重试。打开与改名错误由系统实际返回，其余两项采用故障注入。[文件故障实测](P1_LOCAL_DATA_DESIGN.md#27-新票据写入失败后的账目与文件恢复)

## 2026-11-22 单分支账本与历史票据备份恢复

API 35上，从同一份备份在新目录恢复到842分的修订3，核对了四条历史修订、三份回执、三条待发送记录及两张票据。七份缺件或损坏的备份均被拒绝；重开后当前账本仍为915分的修订4。[原生验证记录](P1_LOCAL_DATA_DESIGN.md#29-同一份备份恢复账本与历史票据)

## 接手检查结论

当前处于P1原生存储候选验证，仓库版本0.0.0。下一项把一笔虚构消费更正及回执查询接入隔离的TS／Capacitor／Android原型，检查提交成功而桥接应答丢失后原操作的恢复。[路线P1](PRODUCT_ROADMAP.md) 真实旧库兼容、多分支／附件、正式共享版本和实际跨设备同步分别验收。

## 2026-11-23 数据共享第一阶段开工

移动工作包 A 已就绪，桌面工作包 B 并行，见[移动侧首单与协作交接](PRODUCT_ROADMAP.md#移动侧首单与协作交接)。在业务代码基线 `49a47e5` 上复跑 `pnpm check:p1-boundary`（55 项输入、42 项集成、7 项调度）、`pnpm check:p1-store`（23 项宿主临时 SQLite 场景）与原生恢复 APK 的 `--build-only`（构建及签名校验通过）。已有 Java 调用方可在写锁忙时保留原意图；本单需从实际 TS 页面经 Capacitor 进入原生事务。在提交前和提交后但桥应答前分别中断，重开核对原 ID、意图、回执、账本和历史票据。本轮为执行准备，新增桥接行为与模拟器结果待交付。桌面新交换样例尚待对方交接。

## 2026-11-23 D1 候选包移动只读回执

桌面固定提交 `09b30b4649060944c5e17321a73ad15f75124f8f` 的导出包通过独立移动检查。manifest 实读 SHA-256 为 `ec9937ce2a6cd0ef2c9fcf311158ffe536efa30915697ad26ba61dae6090065c`。逐一读取四份原始行程与三份附件，核对清单长度、摘要、版本派生数据与固定样例预期。主支三版依次为零笔、一笔虚构午餐 8635 分带票据、同一消费带票据并新增回顾封面照片；备选支从主支首版分叉，零笔、无附件。三份附件字节摘要与 D1 预期相符；在包副本中等长改动票据预览一个字节后，移动检查拒绝。全程未打开正式业务库。该结果仅覆盖固定样例；工作包 A 的桥接恢复独立跟踪。[复跑方法](MAINTAINING.md#d1-固定候选交换包的移动只读回执)

## 2026-11-23 工作包 A 首次执行提交独立评审

执行提交 `5a82aa54d2513f9883163b8d2d9b3faf936f502d` 尚待金额修正，暂缓集成。宿主 `pnpm typecheck` 与 `pnpm check:p1-bridge-command` 通过；执行分支的 `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240` 在隔离 API 35 AVD 上独立通过四个场景。提交前终止与争锁后回滚均以原操作重试，提交后失去应答与争锁后提交均查回原操作，各自最终为修订 3，对应回执／待发送各一，历史票据字节可读。

另外在同一 APK 的四个新虚构场景，分别初始化至修订 2、756 分，选正常提交，在页面输入下列原始值并触摸提交，通过原生状态检查实读。输入 `842.9` 实记 842 分；`1e3` 实记 1 分；`4294968138` 与上限 `9999999999` 均报 `Invalid pending intent arguments`，账本仍为修订 2，无待核实意图。前两例触发页面 `Number.parseInt` 的前缀截取，后两例超出原生桥金额 `Integer` 范围。复现仅使用隔离实验包。

执行者下一项在原分支修正金额输入与传输，核对意图、待核实记录、SQLite 实付及回执金额一致。非法非整分输入必须在产生待核实记录前拒绝；整数等价写法应精确解释或在页面明确拒绝。合法金额范围沿用 P1，全链路（含独立写进程、确认与重放）覆盖 32 位边界及 P1 上限，加上限越界负例，保留现有四条恢复回归。移动负责人独立复验后再集成。

## 2026-11-23 工作包 A：TS／Capacitor／Android 消费更正与回执恢复实测

在执行分支 `antigravity/mobile-p1-bridge-receipt` 新增隔离原型 `prototypes/p1-bridge-receipt/`（包名 `org.travelflow.p1bridge`，复用固定 Capacitor 8.6.0、无新 npm 依赖，保留既有 P0／P1 原型与固定资料）。实际 TS 页面（`bridge-command.ts`、`bridge-app.ts`）按 `p1-host-control-1`／`p1-host-query-1`／`p1-host-intent-c14n-1` 构造并规范化虚构 `expense.patch` 与 `receipt.lookup` 命令，宿主对照 `prototypes/p1-canonical/intent.mjs` 逐字节与 SHA-256 一致；调用原生写入前经同步 `SharedPreferences.commit()` 持久保存原操作 ID 与规范化意图。

在隔离 API 35 模拟器 `travelflow_p0_api35`（`emulator-5580`，x86_64，SQLite 3.44.3，`DELETE`／`FULL`，`-read-only` 覆盖层）通过 CDP 真实触摸完成四项端到端验证，全部 `passed: true`：

- `before-commit`：修订 2（756 分，历史票据 `ticket-1` 可读）提交 842 分更正，事务提交前终止主进程（PID 1843→1988）；重开保留原操作 ID 与意图、账本仍为修订 2 且对应回执／待发送为 0；恢复查得 `no_receipt` 后以原操作 ID 和原意图重试提交一次，最终修订 3（842 分）、历史 4、回执 3、待发送 3、本操作回执／待发送各 1、历史票据可读；同操作重放返回 `replayed`，同 ID 异意图返回 `intent_conflict` 且计数不变。
- `after-commit-drop-reply`：提交 851 分更正，SQLite 提交完成后、Capacitor 桥应答前终止主进程（PID 1988→2082）；重开保留原待核实操作，恢复查得 `confirmed` 而不重复写入，强停冷启动（PID 2180）后状态与计数保持，历史票据可读。
- `lock-busy-commit` 与 `lock-busy-rollback`：独立 `:writer` 进程（PID 2274／2390，与主进程 PID 2192／2307 分离）持有 SQLite 写锁期间，TS 页面触发恢复查询时普通读为 0、串行查询捕获锁异常返回 `pending_busy`，原操作 ID 与意图保留；写方提交或回滚释放锁并强停主进程重开后，前者确认原提交（863 分），后者查无回执并以原请求重试提交一次（874 分），最终均仅有一次有效更正、一份对应回执、一条对应待发送记录且历史票据可读。
- 金额校验与 64 位整数边界回归（`bound-int32-max`、`bound-int32-over`、`bound-max-cents`）：TS 页面在持久化待核实操作前严格拒绝 `842.9`、`1e3`、`10000000000`，每次拒绝后账本与待核实状态完全不变；Android 插件、`:writer` 进程、SQLite、确认与重放全链路改用 64 位 `long` 并核对意图金额一致，实测 `2147483647`、`2147483648`（经 `:writer` 锁竞争与重开确认／重放）与 `9999999999`（经 `after_commit_drop_reply` 重开确认／重放）的原始意图金额与最终入账金额完全一致，历史票据可读。

未验证项：本次仅覆盖单分支虚构消费更正的 API 35 x86_64 隔离模拟器，未覆盖真机、旧 Android／WebView 版本、多操作并发队列、正式业务界面、真实旧库迁移、附件替换联动、断电／磁盘满或跨设备同步；CI 尚未自动运行模拟器。复验命令见 [MAINTAINING](MAINTAINING.md#p1-桥接消费更正与回执恢复复验)。

## 2026-11-23 第一阶段移动集成验收

独立复跑执行提交 `028ec7016ccd12092b2cbbefc0cfacac0e8ffafe`，宿主类型／命令检查、API 35 原四项恢复及三组金额场景通过。页面拒绝小数、科学计数和上限加一，提交与准备两个入口均保持原账、历史、回执、待发送及待核实状态。在 2147483647、2147483648、9999999999 分核对了规范化意图与最终实付；独立写进程和提交后应答丢失分别覆盖后两例。

集成时修正实验页面的异意图检查在接近上限时构造越界金额的问题，兼容首次实验 APK 以 Integer 写入的旧确认金额。最终构建复跑全部七项，并在同一隔离 API 35 模拟器用首版 APK 提交 842 分、保留实验包数据覆盖安装集成 APK，重放命中原回执、金额与计数未变；4294968138 和 9999999998 分均准确保存，同 ID 异意图被拒绝。隔离测试包与本轮端口转发已清理。本轮覆盖虚构消费与历史票据，真机、正式业务库及跨设备同步另验。A 验收通过，B 的 D1 读取回执已获电脑 `459098d` 接受。下项见[共享路线](PRODUCT_ROADMAP.md#第一阶段收口与下一项)。

## 2026-11-24 新增消费候选的宿主执行回执

实读电脑 `5c457e6` 的独立空账本样例。其 Python 与移动 Node 计算的命令 SHA-256 同为 `e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd`，回执查询同为 `6eae8c5e2bbda98cd3e7dab4858f6d573f8593698ce3c9ce97ffee3f45ea8315`。移动宿主实际执行 expense.create：子进程提交前中断后重开为空，用原请求可新建；提交后应答前中断可查回 committed／changed。均查到 1 笔午餐、CNY 8635 分、付款日未知、无票据；初始版与新增版共 2 版，原请求有 1 份回执、1 条待发送。后续备注更正推进当前头后，键顺序变化的原请求仍回到最初版本，计数不增加。改金额或共享票据许可、旧基线的新操作、复用消费 ID 分别得到 intent_conflict、baseline_conflict、entity_exists；非法金额与虚构身份／权限不符的查询均被拒绝。[独立复跑](MAINTAINING.md#桌面新增消费候选的移动宿主复验)

本批覆盖移动宿主事务与固定编码；桌面正式执行器、Android 新增消费以及设备间持久确认另验。现有 Android 首单验证的是更正，不能直接把该证据计入新增。

## 2026-11-24 Android 新增消费首交独立评审

执行提交 `21f6841b3ee0cb5dd56875a25930dc08a924c098` 暂缓合并。执行分支的类型、桥命令、桌面新增消费宿主对照均通过。API 35 隔离 AVD 实跑 `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240`，九项通过。新增前中断保留初版，其余计数为零，原请求重试产生 `fixture-02254c35-6a83-4d1b-b87d-30f6cedfc8e1`；提交后应答前中断查回 `fixture-3c4e522c-8d82-4ea1-b8ee-367e8b70586b`，此时一笔消费、两版、一份回执及一条待发送。备注更正推进当前头后，原请求和键重排重放都返回原新增版本。两个额外对照使用同一 APK 及全新的隔离安装：

1. 保存 8635 分新增请求，在提交前终止进程。保留该待核实记录，让相同操作键、合法的 8636 分意图通过同一原生新增入口先提交；然后实际触摸恢复。结果是账目 8636 分，原 8635 分请求返回 `confirmed_existing` 且 pending 变 null。按键查询 committed 仅证明某个请求已提交。恢复应按持久保存的完整意图核实原回执，金额或仅控制字段不一致时返回冲突、保留待核实意图，已提交账目、版本、回执及待发送均不变。原生写入当前从 rawCommandJson 取业务值，同时独立信任调用方的 canonicalIntentJson 作回执；统一两者来源或在写入前校验一致，补相互矛盾的输入拒绝测试。
2. 正常触摸新增与备注更正后，只读检查实验包已关闭的 SQLite 文件副本。当前 expenses 行有 category=meal、receipt_ids_json=[]；修订 2 和 3 的 snapshot_json 各只有 id、title、amount_cents、currency、paid_on、notes，均缺分类与票据引用等业务字段。改为完整保存该候选支持的消费业务字段（共享票据许可属于命令控制）；以独立固定预期核对各版快照内容、显式 null 和空数组。重开并重放后历史保持原样。

下一次在原执行分支修正两项，保留九项回归，回传提交号。上述实验只使用虚构账本；测试包、端口转发与本次启动的模拟器均已清理。

## 2026-11-24 第二阶段：Android 隔离页面新增消费与恢复实测

在执行分支 `antigravity/mobile-expense-create`（起点 `e5530a7`）复用了 `prototypes/p1-bridge-receipt/`（包名 `org.travelflow.p1bridge`，固定 Capacitor 8.6.0），新增 `BridgeCreateLedgerStore.java` 及 TS 页面空账本 `expense.create` 入口，保留全部 7 组消费更正与金额边界回归。输入严格采用固定样例 `docs/internal/fixtures/p1-desktop-expense-create.json`（SHA-256 `da9a97398ebb1e0e3b8e0e17097a8f8bc79da25602f6e7a119800572341a7b3f`），TS 规范化命令与回执查询摘要与桌面／移动宿主一致（`e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd` 与 `6eae8c5e2bbda98cd3e7dab4858f6d573f8593698ce3c9ce97ffee3f45ea8315`）。

在隔离 API 35 模拟器 `travelflow_p0_api35`（`emulator-5580`，x86_64，SQLite `3.44.3`，`DELETE`／`FULL`，`-read-only` 覆盖层）运行 `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240`，全部 11 组通过（`passed: true`）：

- 既有 7 组更正与金额边界场景全部回归通过（`before-commit`、`after-commit-drop-reply`、`lock-busy-commit`、`lock-busy-rollback`、`bound-int32-max`、`bound-int32-over`、`bound-max-cents`）。
- `create-before-commit`：空账本（`fixture-r0`，消费 0、修订 1、回执 0、待发送 0）提交新增午餐前杀进程（PID `2591 -> 2682`），重开账本仍为空且待核实操作保留；查询得 `not_found_at_settled_read` 后以原操作 ID（`fixture-op-lunch`）和原意图重试提交一次，生成 `fixture-27b2728a-d5ee-4361-bd04-a9760062abd1`，消费 1 笔（`fixture-lunch`、午餐、CNY 8635 分、`paid_on: null`、`category: meal`、`receipt_ids: []` 等全部 13 字段完整），修订 2、回执 1、待发送 1。
- `create-after-commit`：空账本提交成功但在 Capacitor 应答前杀进程（PID `2779 -> 2869`），重开携带完整持久意图查回 `committed`／`changed` 与原结果版本 `fixture-d801f4d2-5dfb-4375-9eb1-748a66ad1b74`，仅确认不重复写入。
- 两组在通过备注更正推进分支头至新版本（修订 3、回执 2、待发送 2）后，重放原请求及键重排请求均返回最初新增结果版本，再次强停冷重开（PID `2779`／`2969`）后逐版核对三份历史快照的全部 13 项业务字段（含分类、票据引用、显式 `null` 与备注变化）均保持原样；改金额（8636）或仅改 `allow_shared_receipts: true` 均返回 `intent_conflict`，旧基线新操作返回 `baseline_conflict`，同消费 ID 新操作返回 `entity_exists`，四个非法金额（`0`、`true`、`1.25`、`10000000000`）按宿主预期分别返回 `integer_range`／`type`，且均零写入；三种虚构身份／权限不符的回执查询均返回 `denied`、无 `receipt` 字段且回执表读取计数未增加。
- 恢复意图核对与写入一致性对照（`create-conflict-amount`、`create-conflict-share`）：已提交原午餐（8635 分、`allow_shared_receipts: false`）后，写入时传入与规范化意图不一致的命令被 `intent_mismatch` 拒绝且零写入；调用方持有同键异金额（8636）或仅改 `allow_shared_receipts: true` 的待核实意图并在冷重开后触发恢复，均返回 `intent_conflict`、保留原待核实记录（`confirmedOp: null`）且账本与全部历史快照不变。

未验证项：本次仅覆盖隔离 API 35 模拟器的单分支虚构新增消费，未覆盖真机、网络同步、生产身份认证与共享契约版本分配。复验入口见 [MAINTAINING](MAINTAINING.md#p1-桥接消费更正与回执恢复复验)。

## 2026-11-24 Android 固定新增消费返修集成验收

执行提交 `95030e6b21086d81c51b94e57a35f8496bad7d0e` 及最终集成 APK 在隔离 API 35 AVD 分别通过 11 个场景。最终版本提交前中断重试的新增结果为 `fixture-2352bae6-2c3c-4963-ad51-dfeed36387e8`，提交后应答丢失查回的新增结果为 `fixture-4f07749d-d4ec-4c3a-bdbe-fd863d66fab4`。头推进后重放保持原结果；金额或仅共享票据许可不同的请求报告冲突，已记消费、回执、待发送和原待核实意图均保留。原始命令与规范化意图不符时拒绝写入。类型、命令摘要与宿主新增检查均通过。

独立重复首次评审的相反顺序：页面挂起 8635 分请求、同键 8636 分先成功，页面恢复返回 intent_conflict，待核实原文未变、未标记确认。另从正常新增与备注更正后的实验库只读副本核对三份 snapshot_json、完整消费字段、父版本关系及原回执。集成版统一当前消费与历史读取，12 项消费字段逐版与固定预期一致。共享票据许可属于命令控制，原意图完整保留供冲突判断。未对旧实验快照补造缺失字段。仅验证单分支固定输入和模拟器，尚无网络同步或正式契约。

已从电脑固定提交 `20c84f0` 归档运行 20 项桌面隔离执行／导出检查，通过。下一项核对两个执行器的能力限制、结果与回执语义：桌面拒绝当前未支持的关联字段，在 2000 笔上限返回 expense_limit_exceeded；移动宿主使用 expense_count。Android 固定午餐成功不证明两端边界均一致。执行范围见[路线](PRODUCT_ROADMAP.md#新增消费的跨端边界对照)。

## 2026-11-24 Android 新增消费边界首交评审

提交 `c309a2d612ae6d334df893c2f5ddca8b0f93fdbe` 暂缓合并。宿主类型、桥命令、固定新增样例和边界脚本通过。独立构建 APK，在隔离 API 35 上复跑全部 13 项通过，第 2000 笔版本为 `fixture-e8dc311c-e317-4e14-a2e7-21d217382cc4`，第 2001 笔拒绝，满额时原操作及键重排均返回原版本。桌面固定提交 `73bb8f4` 的隔离执行器与交换测试 22 项通过；执行者原表明确针对旧提交 `20c84f0`，忙锁、稳定缺失与目标作用域顺序在新桌面基线已有变化。

在同一 APK 的新隔离安装上再次执行满额场景，直接读取页面及已关闭的 SQLite 副本。页面显示“消费 0 笔（合计 ¥0.00）”，而 expenses 表实读 2000 笔、208535 分。初版快照只有 seeded_count=1999，新增版只有 expense_count=2000，无法从这两份快照还原消费明细。代码在超过 20 笔时省略返回列表，并在创建修订时以计数代替历史。这一问题在未达上限时也会触发。该对照只操作虚构数据。

原分支返修范围：
- 保留可还原的完整修订；预置 1999 笔的基线本身也须一致。页面数量及总额从完整账目计算。自动化可返回摘要、分页或按需读取，不要求把所有历史传入 WebView。补 20→21 和 1999→2000 的跨阈值回归，冷重开后核对页面、SQLite 各版的行数／完整内容或独立摘要、版本链；拒绝第 2001 笔及重放后再核对。
- 源码审查发现新增在目标旅行／分支核验前先读旧回执，备注更正入口只检查头版本和消费 ID。两处统一在访问回执前核对目标作用域。新键与已用键遇错目标应给相同拒绝结果，原账、版本、回执、待发均无变化。旧对照表可保留版本标注，补记与桌面 `73bb8f4` 的实际差异，不提前冻结错误名。桌面 `c6319fa` 是共同样例任务单，此处未声称已收到样例产物。

## 2026-11-24 新增消费的跨端边界对照（桌面 `73bb8f4` vs 移动宿主 vs Android 候选）

在执行分支 `antigravity/mobile-create-boundaries`（起点 `5783ba5`）对照桌面隔离执行器 `73bb8f4` 与移动宿主，补齐 Android 候选的可交换字段范围校验、写入前虚构身份与先于回执查询的目标作用域校验、2000 笔上限及满额重放保护，修复超过 20 笔时页面归零与历史快照仅存计数的问题（改为始终持久化全量 12 字段历史快照、分页读取当前／历史明细并提供 SHA-256 摘要），新增宿主检查 `pnpm check:p1-create-boundaries`，并在隔离 API 35 模拟器（`travelflow_p0_api35` / `emulator-5580`，`-read-only`，SQLite `3.44.3`）通过全部 14 组回归（保留原 13 组并新增 `20→21` 场景）：

- `create-boundary-fields-scope`：非空 `paid_on`、`day`、`activity_id`、非空 `receipt_ids`、非空 `budget_item_id`、非 `CNY` 币种均返回 `unsupported_capability`；`settles_budget: true` 与未知 `category` 返回 `invalid_field`；写入前虚构身份不符（未认证、无写权限、错误 `dataset_id`／`source_device_id`）返回 `denied`；新增与备注更正的新键及已用键指向错误 `travel_id`／`branch_id` 均先于回执查询返回 `scope_mismatch` 且零写入；合法午餐（`fixture-b3631ff2-963b-4f0b-bb87-7a02648c1820`）与备注更正（`fixture-82d56c90-9d8c-4411-b167-bd4f5c1208f0`）正常提交。
- `create-boundary-over-20`（`20→21`）与 `create-boundary-cap-2000`（`1999→2000`）：冷重开后页面独立核对 `消费 21 笔（合计 ¥106.35）` 与 `消费 2000 笔（合计 ¥2085.35）` 未归零，`20→21` 经真实 CDP 触摸验证上一页／下一页分页；逐版核对全部历史快照的独立 SHA-256 摘要（`20→21`：`deaca4e0...`／`b9551c6a...`；`1999→2000`：`ec025294...`／`1740e7a9...`）及分页历史明细还原；随后新键拒绝（`entity_exists`／`expense_count`）、原请求与键重排重放（`replayed: true`）及同键异金额冲突（`intent_conflict`）均未改动笔数、总额与两版快照摘要。
- 两端现有差异（待两端共同确认共享错误名与协议版本）：
  - 未支持关联字段：桌面 `73bb8f4` 与 Android 候选均拒绝（`unsupported_capability`／`invalid_field`），产品仍保留完整业务目标；移动宿主在上下文存在时允许上述字段，非 CNY 返回 `currency`。
  - 2000 笔上限错误码：桌面 `73bb8f4` 为 `expense_limit_exceeded`，移动宿主与 Android 候选为 `expense_count`；三者满额重放均返回原结果。
  - 调用身份拒绝码：桌面 `73bb8f4` 为 `unauthorized`（打开 SQLite 前），移动宿主与 Android 候选为 `denied`（写事务前）。
  - 目标旅行／分支不匹配（均先于回执查询拒绝新键与已用键）：桌面 `73bb8f4` 为 `unauthorized`，移动宿主为 `denied`，Android 候选为 `scope_mismatch`。
  - 回执查询缺失／忙锁语义：桌面 `73bb8f4` 与移动宿主均采用 `BEGIN IMMEDIATE`（`not_found_at_settled_read`／`unknown`+`storage_busy`）；Android 候选为 `beginTransactionNonExclusive`（`not_found_at_settled_read`／`pending_busy`，恢复时另核对完整意图并在冲突时返回 `intent_conflict`）。

未验证项：共享错误名定版、共享契约版本号分配、网络同步、生产身份与真机均未纳入本单。

## 2026-11-24 Android 新增消费边界返修集成验收

执行提交 `00f54acdbc78300ec57cc088193ed3c67c1ba9cc` 通过独立复验。宿主类型、桥命令、固定新增与边界脚本通过；API 35、隔离只读 AVD 的新构建运行全部 14 项通过。新增及备注更正均在读取旧回执之前核对旅行与分支，新键和已用键遇错误目标均拒绝；上限后的新操作被拒，已提交操作原样及键重排重放仍返回原结果版本。桌面 `73bb8f4` 的执行器与交换测试从固定归档复跑，22 项通过。两端当前错误名和争锁表达仍分别记录。

另外用同一 APK 全新安装再造两本虚构账。冷重开页面实读 21 笔／106.35 元和 2000 笔／2085.35 元。独立从两个 SQLite 副本逐行解析各两份历史快照，20、21、1999、2000 笔所有消费均与按固定样例独立构造的 12 字段预期一致。两库的当前笔数与整分总额、父子版本、唯一回执和唯一待发送记录与新增版本均吻合。上次超过 20 笔后页面显示零及丢失历史的问题已关闭。仅限新建的隔离样例，未验证真机、网络同步或旧损坏实验快照迁移。合并时保留双方评审记录；应用与验收脚本和执行提交相同。

## 2026-11-24 桌面共同样例移动逐项回执

已按桌面 `fb7ecc0c145486e761567ffc11fdce9198cae907` 的 10 个场景、36 步对照。桌面检查器 10/10 通过；移动复用 `0b43cff` 的宿主与 Android 证据，补测晚餐推进历史、真实写锁下的回执查询、从 1998 笔起步的满额旧键重放及未支持字段的顺序执行。宿主接受显式付款日后发生基线分歧；Android 保留交换子集的拒绝语义。原始错误码、输入跨重启留存的未覆盖项及复跑命令见[共同样例回执](P1_EXPENSE_VECTOR_REVIEW.md)。

## 2026-11-24 Android 待发送输入恢复任务已准备

电脑 `fef2651` 已接收共同样例回执，桌面发送方实现和 Android 进程恢复可并行。移动基线 `9dec892` 的宿主检查再次确认带付款日的午餐可以在宿主本地提交，写锁期间查询返回 unknown / storage_busy。Android 既有完整意图恢复已覆盖提交应答丢失；EC07 写锁与 EC10 能力不匹配时的待发送输入能否跨应用重开保持，仍待本单实测。交接见[Android 并行任务](PRODUCT_ROADMAP.md#android-并行任务重开后保留原待发送消费)。

## Android 待发送恢复首轮独立评审（340a59b，待返修）

从 `340a59bc5c9a1b5eedff737573d1e52ad84180da` 构建 APK，在只读 API 35 AVD `travelflow_p0_api35` 用 `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240 --apk "$candidate_apk"` 独立复跑，16/16 通过。付款日和原始意图在强停后仍可读；可交换午餐丢应答后能找回原版本，最终 1 笔 8635 分、1 份回执。追加页面路径和保留数据升级检查后暂缓合入。

- **丢应答后的页面误报**。完整脚本 EC07 的 `after_commit_drop_reply_reopen` 同屏实读“消费 1 笔（合计 ¥86.35）”与“本机待发送（未入账／未同步）”，状态仍为 `pending_not_found`。前一次查询的缺失不能代表本次提交结果。返修应在尝试提交前持久记录待核实状态，页面区分未发送、结果待核实和已确认；在该断点断言页面语义及恢复后的唯一回执。
- **手动查询覆盖能力阻断**。全新安装，在 EC10 初始化、填付款日 2026-11-23、提交 → 仅核实新增回执 → 查询并恢复。实测 `blocked_unsupported_capability` 被改为 `pending_not_found`，随后再次提交原输入并报 `Retry create failed: {"accepted":false,"error":"unsupported_capability"}`。原日期保留，账本仍为 0。查询缺失应保留阻断原因；补测查询后冷启、恢复，以及无再次提交。
- **旧版待核实记录升级后无法确认**。从 `131b848` 构建并安装旧 APK，在 `create-after-commit` 初始化，以 `after_commit_drop_reply` 提交；在该隔离安装上用 `adb -s emulator-5580 install -r -t "$candidate_apk"` 保留应用数据升级。重开同场景，页面状态和基线为 `undefined`，点击恢复报 `Invalid lookupCreateReceipt arguments`。账本 1 笔 8635 分、回执 1、本机确认空。旧记录仅含 operationId、rawCommandJson、canonicalIntentJson。返修应从原始记录校验并还原恢复所需字段；兼测旧版提交前／后中断，分别用原请求重试或确认已有版本，保留两个版本的构建及升级复跑方式。

返修沿用移动执行分支，保持已有 16 项回归。上述结果来自隔离应用与模拟器，未涉及生产账本、真机或网络传输。

## 2026-11-24 Android 重开后保留原待发送消费实测（EC10 与 EC07）

在执行分支 `antigravity/android-pending-recovery`（起点 `131b848`）复用 `prototypes/p1-bridge-receipt/`（包名 `org.travelflow.p1bridge`，固定 Capacitor 8.6.0），扩展待发送持久记录以保存操作身份、基线、完整原始命令、规范化意图、SHA-256 摘要及区分恢复行为的 `recoveryState`／`lastError`，在隔离 TS 页面增加本机待发送状态与接收端入账事实的明确区分，并扩展 `:writer` 锁竞争提供方以覆盖 EC07 空账本写锁。

在隔离 API 35 模拟器 `travelflow_p0_api35`（`emulator-5580`，x86_64，`-read-only`，SQLite `3.44.3`）运行 `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240`，全部 **16 组**通过（`passed: true`，保留原有 14 组含同键异金额与仅改共享票据许可回归，新增 EC10 与 EC07 两组）：

- `create-pending-ec10`：付款日 `2026-11-23`、8635 分午餐从应用入口提交被拒（`unsupported_capability`）后 `am force-stop` 冷重开（PID `3385 -> 3481`），JS 内存哨兵已清空而原生持久记录完整还原；逐字段核对 `paid_on: "2026-11-23"`、金额 `8635`、基线 `fixture-r0`、操作键 `fixture-op-lunch` 与意图摘要 `d00945b3b59509b07e60c422dfb4cbba73dba17d5e77cd084be7eb7e4b7e064b` 保持原值；接收账本仍空（消费 0、金额 0、修订 1、回执 0、待发送 0）；页面明确显示 `本机待发送（未入账／未同步）` 而非已同步，触发恢复也不会自动删日期重发。
- `create-pending-ec07`：可交换 8635 分午餐（意图摘要 `e85c6c0d3f9c535a4d07eb8e43e33e3daabfbcaf4f85d325eb3e4270c0e34ddd`）依次在独立 `:writer` 进程（PID `3562`）持锁查询返回 `pending_busy` 后强停冷重开（PID `3592`）、释放锁后稳定查询返回 `not_found_at_settled_read` 后强停冷重开（PID `3691`）、以原意图重试提交在应答前终止后冷重开（PID `3781`），每步均核对 JS 内存清空、原操作键／摘要还原、接收端实际金额与回执／待发计数及页面状态；最终仅在匹配完整原意图及持久提交版本 `fixture-c26252d9-3ac9-46c0-88d3-a501fed9e1f6` 后确认，账本 1 笔 8635 分、修订 2、回执 1、待发送 1。

未验证项：本次仅覆盖隔离 API 35 模拟器与可控隔离接收端，未覆盖跨设备真实网络传输、多笔待发送队列并发、真机或共享契约版本分配。

## 2026-11-24 Android 待发送恢复按评审（4f5c32e）返修实测

在执行分支 `antigravity/android-pending-recovery` 上针对主线评审 `4f5c32e` 的三项问题完成返修并独立复跑：

1. **丢应答后页面状态与未发送区分**：TS 页面在发起提交与稳定缺失后重试提交前均持久化 `recoveryState: "pending_verification"`，页面按状态明确区分 `本机待发送（未发送／未入账）`（`pending_unsent`／`pending_not_found`／`blocked_unsupported_capability`）、`提交结果待核实（未确认）`（`pending_verification`／`pending_busy`／`intent_conflict`）与 `已确认入账`。在 `create-pending-ec07` 的 `after_commit_drop_reply_reopen` 阶段实测页面显示 `提交结果待核实（未确认）：操作 fixture-op-lunch · 状态 pending_verification · 金额 8635 分 · 付款日 null · 基线 fixture-r0`（不再残留 `pending_not_found`），随后按匹配完整意图确认至唯一版本 `fixture-76be5947-3a1c-4f74-b790-977d9254b83d`。
2. **手动查询不覆盖能力阻断**：`#create-lookup-only` 遇 `not_found_at_settled_read` 或 `pending_busy` 时不再覆盖已有的 `blocked_unsupported_capability` 与 `lastError`。`create-pending-ec10` 增补回归断言：提交 `paid_on: "2026-11-23"` 遭 `unsupported_capability` 阻断后先点击「仅核实新增回执」，再 `am force-stop` 冷重开（PID `3376 -> 3474`）并点击恢复，全程保持 `blocked_unsupported_capability`、`manualLookupPreservedBlock: true`、接收账本零写入。
3. **`131b848` 保留数据原地升级兼容**：`P1BridgeReceiptPlugin.java` 新增 `normalizeCreatePending`，读取与更新旧版仅含 `{ operationId, rawCommandJson, canonicalIntentJson }` 的持久化待发送记录时，从原命令与规范化意图补全 `datasetId`、`sourceDeviceId`、`expectedRevisionId`、`intentSha256` 及 `recoveryState: "pending_verification"`，并校验 `operationId` 与原命令一致。新增可复现双版本升级脚本 `scripts/check-p1-bridge-upgrade.mjs`。

实测结果（宿主 `pnpm typecheck`、`pnpm check:p1-bridge-command`、`pnpm check:p1-desktop-create`、`pnpm check:p1-create-boundaries` 与脚本语法检查全通过；隔离 API 35 模拟器 `travelflow_p0_api35` / `emulator-5580`，`-read-only`，SQLite `3.44.3`）：

- `node scripts/check-p1-bridge-android.mjs --serial emulator-5580 --cdp-port 19240`：全部 **16 组**通过（`passed: true`），含上述 EC10 手动查询后冷重开阻断保持与 EC07 三阶段页面状态精确断言。
- `node scripts/check-p1-bridge-upgrade.mjs --serial emulator-5580 --cdp-port 19240 --base-ref 131b848`：通过（`passed: true`）。从 `131b848` 覆盖安装当前构建后，页面均正确显示 `提交结果待核实（未确认）：操作 fixture-op-lunch · 状态 pending_verification · 金额 8635 分 · 付款日 null · 基线 fixture-r0`（无 `undefined`）；`create-after-commit` 经查回执直接确认原版本 `fixture-18afdf53-a99e-47eb-b92e-d1ce951c5675`（`confirmed_existing`），`create-before-commit` 经查回执缺失后原意图重试一次提交至 `fixture-9719f7f5-bb6b-40e8-b060-39c2a493aa50`（`recovered_by_retry`），两组最终均 1 笔 8635 分、修订 2、回执 1、待发送 1。

未验证项：本次仍仅覆盖隔离 API 35 模拟器与单笔虚构消费升级恢复，未覆盖真机、跨设备网络同步、多笔并发队列或共享契约版本定版。复跑入口见 [MAINTAINING](MAINTAINING.md#p1-桥接消费更正与回执恢复复验)。

## Android 单笔待发送恢复集成回执

移动执行提交 `f7039f1` 独立构建后在隔离 API 35 模拟器完成 16/16 项回归，另从 `131b848` 的 APK 保留应用数据升级，提交前、提交后两个断点分别通过原意图重试和既有回执确认。上轮评审的三项返修通过。

集成补测发现，先保存带付款日的午餐、再从恢复入口发送时，连续两次点击均收到 `unsupported_capability`，发送方却仍保存 `pending_verification`。集成修正使直接提交和恢复入口都持久保留能力阻断。新增 `create-pending-ec10-saved` 从仅保存原命令开始强停，重开后发送、手动查询、再强停重开并恢复。两条入口均保留 `fixture-op-lunch`、8635 分、付款日 2026-11-23 与基线 `fixture-r0`，查询缺失后仍保持阻断，消费／回执／待发均为 0。

最终构建在 `emulator-5580` 重跑 17/17 项通过，保留数据升级的两种中断另行通过，各自最终一笔 8635 分、两版历史、一份回执和一条待发送记录。宿主类型、桥命令、固定消费和边界检查通过。复跑命令见 [MAINTAINING](MAINTAINING.md#p1-桥接消费更正与回执恢复复验)。范围限于单笔虚构消费和隔离执行器，未验证真机、跨设备传输或并发待发送队列。

同一最终 APK 全新安装后，额外从应用私有 SharedPreferences XML 和 SQLite 只读查询核对两侧。EC07 丢应答后确认的操作为 `fixture-op-lunch`，本机确认版本与库中分支头同为 `fixture-df271ee2-9224-4d74-8a3a-2d2cb74ba773`，实际 1 笔／8635 分／1 回执／1 待发。EC10 仅保存后从恢复入口发送，私有记录保留原日期和金额、状态 `blocked_unsupported_capability`、错误 `unsupported_capability`；接收库仍是 `fixture-r0`，四项计数／金额均为零。

已独立导入桌面 `d193d31` 新增消费候选。四组摘要相符，宿主和 Android 成功重放与最小回执负例均通过。待桌面复核宿主非法字段原码及接收回执摘要存储差异，再评审共享版本。[固定包、逐项证据与复跑](P1_EXPENSE_VECTOR_REVIEW.md#独立导入-010-candidate1)
