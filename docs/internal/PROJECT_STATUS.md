# 移动端项目现状

2026-11-05：从TravelFlow-AI迁出P0实验，源码来源974743f；契约来源见vendor/contracts/ORIGIN.json，设计来源见vendor/design/ORIGIN.json。框架仍是Capacitor候选，正式Android应用、完整账本和同步均未实现。版本0.0.0仅标识开发仓库，不是产品发布。

## 能力与证据

迁移前原型在WSL2/KVM的Android15（API35、default x86_64、WebView124.0.6367.219）验证：原生SQLite保存123分、同ID重放不增加；飞行模式下强停重开仍保留，可追加到246分；再次强停保持；原生HTTP虚构服务POST200，服务／网络失败后仍可追加至369分。只读导出的虚构SQLite副本核对3条／369分／3个唯一ID。历史证据归属桌面提交974743f，不能冒充迁移后重新跑过。

迁移后首次验证已完成：新仓库独立冻结安装、快照来源／摘要检查、14组账目对照、非法输入防护、TS类型检查、脚本语法与Python编译通过；篡改快照与浮动Git版本被拒绝，npm审计零已知漏洞。独立生成路径包含空格的工程，复用隔离SDK缓存离线执行`:app:assembleDebug`通过（JDK21、SDK36、Build Tools35.0.0）。新APK全部assets与迁移前逐字节一致，两个Java源码也保持一致；首次迁移检查未重新运行模拟器交互，不将历史运行证据写成重新验证。生成工程在`/tmp/travelflow mobile standalone p0/`，不进入Git。初始提交8443cd0的远端CI通过（含独立APK构建）。vendor快照固定LF，另在core.autocrlf=true的检出副本验证摘要保持；这不是Windows原生APK构建或真机验收。e7d77a1的远端CI也已通过；当时只补接续文档，未重跑APK／模拟器。最新CI仍按提交核对，未正式发布。当前构建与检查入口见MAINTAINING，当前下一项见PRODUCT_ROADMAP。 SDK及生成工程均在仓库外；不读取个人旅行、配置或真实供应商。

## 未覆盖

已有单台ARM64真机启动／本地存储／强停恢复证据，真机网络与凭据尚未验证，最低系统／WebView边界仍未确定；存储不足、升级迁移、正式凭据生命周期／硬件安全背书、公网供应商HTTPS／鉴权、TCP SYN／DNS阶段取消与真实供应商流式／续传仍未覆盖。没有正式签名或发布。下述模拟器和固定本地服务证据不能推广为上述能力已通过。桌面端Windows／WSL启动和网络连接原型由原仓库负责，移动构建不导入桌面源码。跨端契约目前只有只读账目投影0.1.0，不是完整数据或同步契约。

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
| Android13 API33 Google APIs／WebView109／x86_64 | 存储、HTTP／TLS、断网冷启动与凭据冷读通过 | 3条／369分；此组合未逐项重做API35全部历史边界 |
| Android16 API36 Google APIs／WebView133／x86_64 | 同类网络／凭据及本地触摸／强停恢复通过 | 后续USB配置验收后8条／984分；系统ABI列表含ARM64不能当真机证据 |
| 用户授权ELI-AN00手机／API36／WebView150／ARM64 | 启动、实际触摸保存／同ID重放、强停恢复通过 | 仅本地验收，1条／123分；未运行真机网络／凭据测试，未切换手机网络 |
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

此配置截至本节仅在隔离模拟器执行。未更新用户手机、未创建手机反向转发、未执行真机网络或凭据测试；此前手机1条／123分及本地授权不自动扩展。下一步在候选APK和操作范围可审阅后，请用户明确是否更新该指定手机并执行USB本地虚构服务的HTTP／TLS及公开虚构凭据测试；不调用真实供应商、不读真实密钥、不切换手机网络、不修改系统CA。需要支持的旧系统64位引擎、正式凭据生命周期和TCP／DNS阶段边界仍保留。

## 接手检查结论

本仓库文档现已覆盖独立安装／检查／debug与unsigned release构建、可选本机缓存、隔离模拟器启动与明确设备选择、HTTP／流式／HTTPS／虚构凭据验收、旧系统／提供方诊断、框架评审、P0下一项及跨仓变更协作。足以接续P0调查，不代表完整移动产品需求和同步协议已设计完成。手机具体交互、正式框架、最低版本、凭据与传输方案仍按路线评审；无需依赖旧聊天中的临时脚本。本次修改应用实验入口与开发检查，未改领域实现、共享契约或设计快照。
