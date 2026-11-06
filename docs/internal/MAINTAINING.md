# 开发维护入口

本页供维护者和协作AI使用；产品说明见[README](../../README.md)，当前证据见[PROJECT_STATUS](PROJECT_STATUS.md)，下一项见[PRODUCT_ROADMAP](PRODUCT_ROADMAP.md)。先执行 `git status --short --branch`、`git log -3 --oneline`，确认修改归属。项目约定见[AGENTS](../../AGENTS.md)。

## 独立准备与校验

需要Node 22+、pnpm 12.6.0。仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:contracts
pnpm check:ledger
pnpm typecheck
node scripts/prepare-android-probe.mjs --output /tmp/travelflow-mobile-probe
```

生成目录必须不存在，脚本拒绝覆盖。Windows可使用自己的新目录路径；构建不读取电脑仓库或Python业务，也不拉取其main。首次安装依赖仍需网络，只有显式更新契约才需上游Git副本。生成器在目标目录按独立锁文件安装Capacitor候选，不安装SDK或接受许可。

Android构建需JDK21、SDK Platform36、Build Tools35.0.0；Gradle wrapper8.14.3、AGP8.13.0。为当前进程设置自己的JAVA_HOME／ANDROID_HOME／ANDROID_USER_HOME／GRADLE_USER_HOME，在生成工程android目录运行 `./gradlew :app:assembleDebug --no-daemon`，Windows用gradlew.bat。debug APK在 `app/build/outputs/apk/debug/app-debug.apk`。本机已授权用于隔离原型的SDK许可与下载，缓存沿用 `~/.cache/travelflow-p0-android/`；其他贡献者自行安装并接受许可。CI只构建候选APK，不发布或签署正式安装包。

## 本机隔离环境与模拟器接续

这些是已有WSL开发环境的可选缓存，先确认存在，不作为其他贡献者的安装前提：SDK在`~/.cache/travelflow-p0-android/sdk`，JDK21在同缓存的`jdk21/jdk-21.0.13+9`，Gradle缓存为`gradle`，Android用户配置为`android-user`，AVD为`avd`。不要复制个人配置、修改全局环境或清理其他设备。

已有隔离AVD名`travelflow_p0_api35`，系统镜像API35/default/x86_64；其历史WebView为124。可先运行：

```sh
export ANDROID_HOME="$HOME/.cache/travelflow-p0-android/sdk"
export ANDROID_USER_HOME="$HOME/.cache/travelflow-p0-android/android-user"
export ANDROID_AVD_HOME="$HOME/.cache/travelflow-p0-android/avd"
"$ANDROID_HOME/emulator/emulator" -accel-check
"$ANDROID_HOME/emulator/emulator" -list-avds
"$ANDROID_HOME/platform-tools/adb" devices
```

确认5580端口未被其他模拟器占用、上述AVD存在后，可另开开发终端运行 `"$ANDROID_HOME/emulator/emulator" -avd travelflow_p0_api35 -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 1536 -cores 2`。若已有自己的实例则复用，不能默认重置或清数据；缺少AVD时按[Android官方AVD工具说明](https://developer.android.com/tools/avdmanager)创建自己的隔离镜像。先确认启动完成，再向明确的`emulator-5580`安装生成工程中的debug APK。所有ADB命令指定`-s emulator-5580`，不能使用默认第一台设备；验收后仅关闭自己启动的实例、回显服务和端口转发。

应用启动命令为 `adb -s emulator-5580 shell am start -n org.travelflow.p0/.MainActivity`，强停用 `adb -s emulator-5580 shell am force-stop org.travelflow.p0`；这里adb指上面SDK的platform-tools/adb，未加入PATH时使用完整路径。安装APK、切换网络、强停都仅限隔离模拟器。SDK／生成工程路径可能在机器清理后消失，应按文档重新准备，不能把旧/tmp路径存在当作验收前提。

页面调试：debug WebView支持页面CDP，先用ADB的`pidof org.travelflow.p0`取得当前PID，再转发该PID对应的`localabstract:webview_devtools_remote_<PID>`到自己选择的本机端口。重启应用后PID会变，需重新转发。历史Playwright CLI／connectOverCDP因WebView不支持桌面浏览器上下文管理失败，实际触摸验证使用页面CDP的`Input.dispatchTouchEvent`；不要把桌面浏览器测试替代原生插件验证。

## 原型交互验收

可选测试对端：`python scripts/android_probe_service.py`，仅监听127.0.0.1:18510，不读取.env，Python仅用于开发测试。只向自己的隔离模拟器安装org.travelflow.p0；打开后原生桥就绪，保存1.23元，重放同一操作条数／金额不增加；强停重开保持，关闭网络后冷启动可继续新增。恢复网络时测试POST通过；停止测试服务后网络失败，但本地继续保存。已有记录不会因重开归零，不能默认每次验收从空库开始。

服务无CORS；原生HTTP访问10.0.2.2的宿主回显服务，虚构token非真实鉴权。仅debug为该地址允许明文，release默认拒绝；此地址不适用真机。未调用真实模型／地图，流式／取消实验见下一节。浏览器无法提供原生插件能力；不可把桌面触屏模拟当Android验收。

## 原生流式／取消验收

生成器现会包含`ProbeStreamPlugin.java`：使用Android自带的`HttpURLConnection`和UTF-8读取器，在独立工作线程读取受控SSE；另一个线程执行`disconnect()`，避免桥线程被取消操作阻塞。本探针只接受固定模式和虚构请求ID，只访问`10.0.2.2:18510`，不接收任意URL、凭据或业务数据，不增加依赖，也不替代原有SQLite／普通HTTP实验。

准备新工程、构建并向明确的隔离模拟器安装后，运行上面的`python scripts/android_probe_service.py`。页面依次操作「分块输出」「读取超时」「中途断开」「从上次分块恢复」；另开一次「读取超时」，在首块出现后点「取消原生请求」。预期：中文逐块显示；停顿约1.5秒触发`TIMEOUT`；截断响应是失败；显式恢复只显示第2、3块；取消终态后不再追加分块，本地保存按钮始终可用。恢复编号只在当前页面内存中保留，重启后的续传、真实供应商恢复语义尚未定义。测试服务通过分块编码故意切开中文UTF-8字节，末尾使用实验性`[DONE]`标记；当前解析器不代表通用SSE／供应商适配器。

可复现自动验收使用Node22+内置WebSocket，通过页面CDP真实触摸按钮并检查原生事件；不用桌面浏览器代替Android。确认选定本机端口未占用，按当前PID执行转发（将`<PID>`和`<PORT>`替换为实际值）：

```sh
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 shell pidof org.travelflow.p0
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 forward tcp:<PORT> localabstract:webview_devtools_remote_<PID>
node scripts/check-android-stream.mjs --port <PORT>
```

脚本要求测试服务运行，输出`passed: true`及分块、取消、服务端断连和恢复时序。它会向虚构数据库追加一条123分并重放同ID，既有记录保留；不要要求初始金额为零。它同时验证正常完成、内置HTTP整包返回对照、阻塞读取消、立即取消、并发请求拒绝、错误ID取消拒绝、读取超时、截断后按`Last-Event-ID`重连、HTTP503及本地记录不受影响。取消必须在1秒内返回原生终态，且服务端在读取超时前观察到`peer_closed`，只忽略JS回调不算通过。脚本未验证连接超时、总时限或任意网络阶段的取消。

断网冷启动验收：仅对明确的`emulator-5580`执行`adb shell cmd connectivity airplane-mode enable`，强停后重启应用，更新PID与端口转发，再运行`node scripts/check-android-stream.mjs --port <PORT> --offline`。预期网络请求报错，原有余额保留、新增123分且重放不增加。恢复飞行模式原状态后，单独停止自己的测试服务，再运行同一`--offline`命令验证服务不可用；此参数只断言请求失败及本地写入可用，不替操作者证明或切换飞行模式。最后恢复服务和网络，强停重开核对金额并再次「分块输出」。不得清库。结束后移除自己的`adb -s emulator-5580 forward --remove tcp:<PORT>`，停止自己的服务与模拟器。

## 契约与设计快照更新

权威数据契约在电脑仓库contracts，移动侧vendor/contracts保存固定版本。根目录执行 `node scripts/import-contract.mjs --source <电脑仓库Git副本> --commit <完整40位提交SHA>`，仅显式更新时需要此副本；导入前验证上游摘要，再运行三项检查、审阅差异并提交。当前导入器只支持实验ledger-v1，不是未来同步协议协商工具。既有契约版本不可原地改写；新规则需先由两端评审版本与迁移。

vendor/design为固定提交样式快照，更新时逐文件对照上游，更新ORIGIN摘要并审阅主题／按钮状态；不能把复制等同实时共享。src/domain/ledger.ts由移动端维护，受共享样例约束，不会自动跟随桌面Python实现。


## 下一项调查入口与跨仓协作

本仓库下一项由[移动路线P0](PRODUCT_ROADMAP.md)安排。已核对`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/CapacitorHttp.java`及同目录下的`util/HttpRequestHandler.java`：8.6.0实现读取完整响应后才resolve，公开请求接口没有单请求取消；销毁插件时的disconnect不等于用户可取消请求。原生适配探针已有上面的分块／取消／超时／显式恢复验收入口，实际证据见PROJECT_STATUS；这只证明此环境中自建适配可行，不正式选定框架。接下来补凭据与HTTPS失败证据、连接阶段取消／超时，以及兼容性评审。参考[官方HTTP接口](https://capacitorjs.com/docs/apis/http)与[Android连接说明](https://developer.android.com/reference/java/net/HttpURLConnection)，仍以固定依赖源码和实际运行结果为准。

电脑端由另一会话负责。完整业务清单与保护约束见[接口能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CAPABILITIES.md)、[跨端总计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CONTINUITY_PLAN.md)。本地读写离线完整、联网后手机独立调用在线服务、双方在线直接同步已确定；无常驻应用服务器，本里程碑不加入云存储，第三方账号／中继与具体连接工具尚未批准。不能按个人机型缩窄开源兼容范围，也不因旅中优先删减规划／高级工程／回顾。

移动侧可自主验证平台适配；需要改变数据含义、共享契约或电脑配合时，先形成带版本的规格差异、需要电脑侧提供的接口和联合验收条件，交用户协调两会话，不能直接改电脑仓库或默认其会立即升级。契约仅导入已审阅的固定提交，升级后分别记录两端支持版本；不要把凭据加入业务同步或公开调试日志。设计快照、API矩阵是参考资料，不是移动功能已获用户验收的证明。
