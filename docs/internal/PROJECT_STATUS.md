# 移动端项目现状

2026-11-05：从TravelFlow-AI迁出P0实验，源码来源974743f；契约来源见vendor/contracts/ORIGIN.json，设计来源见vendor/design/ORIGIN.json。框架仍是Capacitor候选，正式Android应用、完整账本和同步均未实现。版本0.0.0仅标识开发仓库，不是产品发布。

## 能力与证据

迁移前原型在WSL2/KVM的Android15（API35、default x86_64、WebView124.0.6367.219）验证：原生SQLite保存123分、同ID重放不增加；飞行模式下强停重开仍保留，可追加到246分；再次强停保持；原生HTTP虚构服务POST200，服务／网络失败后仍可追加至369分。只读导出的虚构SQLite副本核对3条／369分／3个唯一ID。历史证据归属桌面提交974743f，不能冒充迁移后重新跑过。

迁移后首次验证已完成：新仓库独立冻结安装、快照来源／摘要检查、14组账目对照、非法输入防护、TS类型检查、脚本语法与Python编译通过；篡改快照与浮动Git版本被拒绝，npm审计零已知漏洞。独立生成路径包含空格的工程，复用隔离SDK缓存离线执行`:app:assembleDebug`通过（JDK21、SDK36、Build Tools35.0.0）。新APK全部assets与迁移前逐字节一致，两个Java源码也保持一致；首次迁移检查未重新运行模拟器交互，不将历史运行证据写成重新验证。生成工程在`/tmp/travelflow mobile standalone p0/`，不进入Git。初始提交8443cd0的远端CI通过（含独立APK构建）。vendor快照固定LF，另在core.autocrlf=true的检出副本验证摘要保持；这不是Windows原生APK构建或真机验收。e7d77a1的远端CI也已通过；当时只补接续文档，未重跑APK／模拟器。最新CI仍按提交核对，未正式发布。当前构建与检查入口见MAINTAINING，当前下一项见PRODUCT_ROADMAP。 SDK及生成工程均在仓库外；不读取个人旅行、配置或真实供应商。

## 未覆盖

没有真机或ARM64运行证据，最低系统／WebView边界尚未确定；存储不足、升级迁移、正式凭据生命周期／硬件安全背书、公网供应商HTTPS／鉴权、TCP SYN／DNS阶段取消与真实供应商流式／续传仍未覆盖。没有正式签名或发布。下述模拟器和固定本地服务证据不能推广为上述能力已通过。桌面端Windows／WSL启动和网络连接原型由原仓库负责，移动构建不导入桌面源码。跨端契约目前只有只读账目投影0.1.0，不是完整数据或同步契约。

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

| 系统／提供方组合 | 本轮实际结果 | 证据边界 |
| --- | --- | --- |
| Android15 API35／WebView124／x86_64 AVD | 最终构建的能力诊断、真实触摸与TLS全套回归通过 | 保留原模拟器历史虚构库，最终12条／1476分；未重跑此前全部离线历史验收 |
| Android11 API30／自带WebView83／x86_64 AVD | 诊断实测缺少`randomUUID`与`cssLayers`，旧构建曾停在初始化；最终经典启动脚本明确提示更新、全部按钮禁用、未加载应用模块 | 验证的是当前构建不满足所需能力；不是宣布所有旧内核不支持。已有123分的SQLite在提示前后逐字节一致 |
| 同一API30 AVD／更新为WebView124 | 最终构建能力检测、TLS与凭据／401／307／错误证书／握手取消及超时／总时限、HTTP流式／恢复／重放、断网强停冷启动和恢复网络后凭据冷读均通过 | 4条／492分为该独立AVD的虚构库，不是跨端同步；不是ARM64或Android7／8证据 |
| Android8 API26/default revision1／自带58或安装124 | APK安装成功，创建WebView时失败；系统允许的Chrome／Google提供方不含`com.android.webview`，`Current WebView package is null`，日志`MissingWebViewPackageException` | 测试环境阻塞，未修改白名单或重签组件来制造通过；不能据此认定TravelFlow业务不兼容API26 |

API30/default/x86_64 revision11、API26/default/x86_64 revision1均通过官方SDK工具安装在既有隔离缓存，新建专用AVD且不覆盖已有实例。API30使用`travelflow_p0_api30`／`emulator-5582`，API26失败调查后关闭，同一端口随后由明确的API30实例使用；API35仍在5580。WebView124只从已有官方API35镜像提取到仓库外，核对包名、minSdk26及ABI后用于隔离更新，不分发给用户。API26框架配置的提供方列表已从实际`framework-res.apk`核对；仅安装满足minSdk的APK不足以保证系统接受其作为WebView。

本轮改动包括经典`bootstrap.js`启动保护、窄视口控件宽度约束、当前WebView只读诊断、debug域显式`includeSubdomains=false`和APK范围断言。共享设计快照未改。当前构建原样使用模块、顶层await、可选链和现代CSS，不能从框架声明的WebView60推导应用可用，也未将99等源码推测值写成正式最低内核。基线DEX中的`Set.of`调用已由D8改写为兼容实现，没有仅凭API文档判它为必然崩溃。

原生触摸脚本在API30最初因可视视口偏移而点中按钮下方文字；修正为等待绘制、扣除`visualViewport`偏移并检查点击中心可见后，真实触摸全套通过，不以JS `.click()`替代。最终API30布局／内容宽度均122CSS像素（320×640、420dpi的额外窄视口），API35均320，无横向溢出；未作为正式手机交互验收。

API30数据保护过程：先保存／重放固定ID至123分，WebView83的启动提示不改该库；更新124后TLS验收追加至246分，HTTP验收至369分。飞行模式下强停重开保留369分，网络请求明确失败，本地追加／重放后492分；恢复原网络状态后再次强停，`--cold-start`不重新准备凭据，HTTPS完成，仍4条／492分。未清库、未修改原生表结构或领域口径。API35本轮两次TLS回归将既有1230分追加到1353、1476分，均为实验新增，不是正式财务写入。

最终工程`/tmp/travelflow-mobile-compat-reviewed/`冻结生成、debug／unsigned release离线构建及主源码`lintAnalyzeDebug`通过；实际APK范围检查通过，无自带`.so`或私钥，release无测试CA／明文例外。旧debug APK缺少显式子域范围，被新检查器拒绝。主源码lint原有的debug网络配置错误已消除，仍有7条模板图标／manifest等警告。本机完整`lintDebug`因测试依赖未缓存、联网下载JUnit时TLS握手失败而未完成，不把主源码分析当完整lint；CI已增加完整debug lint，结果按实际提交核对。没有为此关闭TLS验证或跳过新的检查。

运行输出为仓库外`/tmp/travelflow-mobile-compat-*.json`，API26错误另有`/tmp/travelflow-mobile-api26-*.txt`；复现不依赖这些临时文件，步骤在MAINTAINING。API24尚未运行，API26仍需匹配提供方的合法镜像／组件；正式业务、同步与真机范围仍未实现，P0未收口。下一项按评审继续补上述边界，再交用户确认框架与拟支持范围。

## 接手检查结论

本仓库文档现已覆盖独立安装／检查／debug与unsigned release构建、可选本机缓存、隔离模拟器启动与明确设备选择、HTTP／流式／HTTPS／虚构凭据验收、旧系统／提供方诊断、框架评审、P0下一项及跨仓变更协作。足以接续P0调查，不代表完整移动产品需求和同步协议已设计完成。手机具体交互、正式框架、最低版本、凭据与传输方案仍按路线评审；无需依赖旧聊天中的临时脚本。本次修改应用实验入口与开发检查，未改领域实现、共享契约或设计快照。
