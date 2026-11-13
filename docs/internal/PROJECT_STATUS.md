# 移动端项目现状

2026-11-05：从TravelFlow-AI迁出P0实验，源码来源974743f；契约来源见vendor/contracts/ORIGIN.json，设计来源见vendor/design/ORIGIN.json。框架仍是Capacitor候选，正式Android应用、完整账本和同步均未实现。版本0.0.0仅标识开发仓库，不是产品发布。

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

## 接手检查结论

本仓库文档现已覆盖独立安装／检查／debug与unsigned release构建、可选本机缓存、隔离模拟器启动与明确设备选择、HTTP／流式／HTTPS／虚构凭据验收、旧系统／提供方诊断、框架评审、P0下一项及跨仓变更协作。足以接续P0调查，不代表完整移动产品需求和同步协议已设计完成。手机具体交互、正式框架、最低版本、凭据与传输方案仍按路线评审；无需依赖旧聊天中的临时脚本。本次修改应用实验入口与开发检查，未改领域实现、共享契约或设计快照。
