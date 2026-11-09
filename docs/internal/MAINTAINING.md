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

确认5580端口未被其他模拟器占用、上述AVD存在后，可另开开发终端运行 `"$ANDROID_HOME/emulator/emulator" -avd travelflow_p0_api35 -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 1536 -cores 2`。若已有自己的实例则复用，不能默认重置或清数据；缺少AVD时按[Android官方AVD工具说明](https://developer.android.com/tools/avdmanager)创建自己的隔离镜像。先确认启动完成，再向明确的`emulator-5580`安装生成工程中的debug APK。本节API35的ADB命令指定`-s emulator-5580`，其他隔离组合见兼容性一节；不能使用默认第一台设备。验收后仅关闭自己启动的实例、回显服务和端口转发。

应用启动命令为 `adb -s emulator-5580 shell am start -n org.travelflow.p0/.MainActivity`，强停用 `adb -s emulator-5580 shell am force-stop org.travelflow.p0`；这里adb指上面SDK的platform-tools/adb，未加入PATH时使用完整路径。安装APK、切换网络、强停都仅限隔离模拟器。SDK／生成工程路径可能在机器清理后消失，应按文档重新准备，不能把旧/tmp路径存在当作验收前提。

页面调试：debug WebView支持页面CDP，先用ADB的`pidof org.travelflow.p0`取得当前PID，再转发该PID对应的`localabstract:webview_devtools_remote_<PID>`到自己选择的本机端口。重启应用后PID会变，需重新转发。历史Playwright CLI／connectOverCDP因WebView不支持桌面浏览器上下文管理失败，实际触摸验证使用页面CDP的`Input.dispatchTouchEvent`；不要把桌面浏览器测试替代原生插件验证。

## 原型交互验收

可选测试对端：`python scripts/android_probe_service.py`，仅监听127.0.0.1:18510，不读取.env，Python仅用于开发测试。只向自己的隔离模拟器安装org.travelflow.p0；打开后原生桥就绪，保存1.23元，重放同一操作条数／金额不增加；强停重开保持，关闭网络后冷启动可继续新增。恢复网络时测试POST通过；停止测试服务后网络失败，但本地继续保存。已有记录不会因重开归零，不能默认每次验收从空库开始。

服务无CORS；原生HTTP访问10.0.2.2的宿主回显服务，虚构token非真实鉴权。仅debug为该地址允许明文，release默认拒绝；此地址不适用真机。未调用真实模型／地图，流式／取消实验见下一节。浏览器无法提供原生插件能力；不可把桌面触屏模拟当Android验收。

## 原生流式／取消验收

生成器包含`ProbeStreamPlugin.java`：使用Android自带的`HttpURLConnection`和UTF-8读取器，在独立工作线程读取受控SSE；另一个线程执行`disconnect()`，避免桥线程被取消操作阻塞。探针只接受固定模式、传输类型和虚构请求ID，只访问`10.0.2.2:18510–18515`，不接收任意URL、真实凭据或业务数据，不增加运行时依赖，也不替代原有SQLite／普通HTTP实验。默认选HTTP；下节说明可选HTTPS服务。

准备新工程、构建并向明确的隔离模拟器安装后，运行上面的`python scripts/android_probe_service.py`。页面依次操作「分块输出」「读取超时」「中途断开」「从上次分块恢复」；另开一次「读取超时」，在首块出现后点「取消原生请求」。预期：中文逐块显示；停顿约1.5秒触发`TIMEOUT`；截断响应是失败；显式恢复只显示第2、3块；取消终态后不再追加分块，本地保存按钮始终可用。恢复编号只在当前页面内存中保留，重启后的续传、真实供应商恢复语义尚未定义。测试服务通过分块编码故意切开中文UTF-8字节，末尾使用实验性`[DONE]`标记；当前解析器不代表通用SSE／供应商适配器。

可复现自动验收使用Node22+内置WebSocket，通过页面CDP真实触摸按钮并检查原生事件；不用桌面浏览器代替Android。确认选定本机端口未占用，按当前PID执行转发（将`<PID>`和`<PORT>`替换为实际值）：

```sh
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 shell pidof org.travelflow.p0
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 forward tcp:<PORT> localabstract:webview_devtools_remote_<PID>
node scripts/check-android-stream.mjs --port <PORT>
```

脚本要求页面选择HTTP、测试服务运行，输出`passed: true`及分块、取消、服务端断连和恢复时序。它会向虚构数据库追加一条123分并重放同ID，既有记录保留；不要要求初始金额为零。它同时验证正常完成、内置HTTP整包返回对照、阻塞读取消、立即取消、并发请求拒绝、错误ID取消拒绝、读取超时、截断后按`Last-Event-ID`重连、HTTP503及本地记录不受影响。取消必须在1秒内返回原生终态，且服务端在读取超时前观察到`peer_closed`，只忽略JS回调不算通过。连接阶段与总时限使用下节的专门验收，不能由本脚本推断。

断网冷启动验收：仅对明确的`emulator-5580`执行`adb -s emulator-5580 shell cmd connectivity airplane-mode enable`，强停后重启应用，更新PID与端口转发，再运行`node scripts/check-android-stream.mjs --port <PORT> --offline`。预期网络请求报错，原有余额保留、新增123分且重放不增加。恢复飞行模式原状态后，单独停止自己的测试服务，再运行同一`--offline`命令验证服务不可用；此参数只断言请求失败及本地写入可用，不替操作者证明或切换飞行模式。最后恢复服务和网络，强停重开核对金额并再次「分块输出」。不得清库。结束后移除自己的`adb -s emulator-5580 forward --remove tcp:<PORT>`，停止自己的服务与模拟器。

## HTTPS、虚构凭据与连接阶段验收

额外开发工具为OpenSSL和Python3.9+标准库。以下目录均需是仓库外的新目录，生成器拒绝覆盖；证书有效期2天，过期后重新生成一套，不能关闭证书验证。只向自己的隔离模拟器安装debug APK，不向Android系统或宿主安装CA：

```sh
python scripts/prepare-probe-tls.py --output /tmp/travelflow-probe-tls
node scripts/prepare-android-probe.mjs --output /tmp/travelflow-probe-tls-app --tls-fixtures /tmp/travelflow-probe-tls
python scripts/android_probe_service.py --tls-fixtures /tmp/travelflow-probe-tls
```

按上文构建、安装和转发当前WebView后，运行`node scripts/check-android-tls.mjs --port <PORT>`，预期`passed: true`。本脚本会生成／移除／重建专用虚构凭据，向虚构账本追加123分并重放一次，不清库。选择器由脚本设值，按钮通过页面CDP真实触摸。手工入口为「准备虚构凭据」、选择HTTPS类型、再操作分块、缺少／错误虚构凭据、拒绝重定向、TLS握手停顿及取消、持续分块与总时限。

端口18510为HTTP与只读观测，18511为有效HTTPS，18512为不受信任证书，18513为主机名不匹配，18514为过期证书，18515接收TLS ClientHello但不回复。预期：有效HTTPS返回中文分块；三类错误证书返回`TLS_FAILED`且没有HTTP请求；缺少／错误授权返回HTTP401；重定向返回HTTP307且目标未收到请求。TLS握手停顿应约1500毫秒返回`CONNECT_TIMEOUT`，握手期间取消应在1秒内出现原生终态且服务端观察到关闭。此实验已完成TCP连接，不能冒充TCP SYN黑洞或DNS阶段验证。

`drip`模式每约500毫秒输出一块，单次读取不会触发1500毫秒读取超时，但2500毫秒总时限应产生`DEADLINE`并关闭连接。其他模式总时限固定6000毫秒。这些值都是测试阈值，尚非产品策略；异常事件区分连接／读取阶段与HTTP状态，不返回底层包含请求信息的异常消息。

`ProbeCredentials.java`只允许公开的固定虚构值：AES密钥由AndroidKeyStore管理，AES-GCM密文与IV位于应用私有`shared_prefs/p0-synthetic-credential.xml`，不写账本、不通过JS桥返回、不参与同步；「移除」仅处理该专用文件内容与`travelflow_p0_synthetic_v1`别名。强停重开、更新PID／转发后运行`node scripts/check-android-tls.mjs --port <PORT> --cold-start`，脚本不会重新准备凭据，预期仍能完成HTTPS。点击「移除虚构凭据」后可运行`--expect-credential-failure`，预期`CREDENTIAL_UNAVAILABLE`且账本不变；完成后显式重新准备虚构凭据。

损坏密文的开发复现仅限该隔离模拟器：先强停，用`adb -s emulator-5580 exec-out run-as org.travelflow.p0 cat shared_prefs/p0-synthetic-credential.xml`保存仓库外备份；在副本中Base64解码`ciphertext`、翻转一个字节再编码，保留原IV及有效XML。用`adb -s emulator-5580 push`暂存到专用`/data/local/tmp/travelflow-p0-credential-fixture.xml`，再以`adb -s emulator-5580 shell run-as org.travelflow.p0 cp`复制到上述专用prefs文件。重启／更新转发后运行`--expect-credential-failure`，应明确失败且不删除密文或账本。最后强停、按同样方式还原备份、删除暂存文件，再冷启动验收。不要直接修改SQLite或其他prefs；不能将该虚构文件操作套到用户凭据。

不带`--tls-fixtures`生成的debug默认只信任系统CA；向隔离模拟器替换安装该APK后运行`--expect-untrusted`，预期连有效测试证书也被拒绝。带测试CA的工程只在debug的`10.0.2.2`域配置引用它；main／release只信任系统CA并拒绝明文。可构建`:app:assembleDebug :app:assembleRelease`（release不签名、不安装、不发布），再检查实际打包资源：

```sh
python scripts/check-probe-apk.py --aapt2 "$ANDROID_HOME/build-tools/35.0.0/aapt2" --debug <DEBUG_APK> --release <UNSIGNED_RELEASE_APK> --tls-fixtures /tmp/travelflow-probe-tls
```

预期debug仅含一个测试CA，release无测试CA、无明文例外、无备份权限，双方无私钥。CI执行该打包检查，不运行模拟器。TLS私钥和证书目录必须留在仓库外；生成器只复制经摘要核对的单个公开CA到debug，篡改摘要会被拒绝。资料依据见[Android网络配置](https://developer.android.com/privacy-and-security/security-config)及[AndroidKeyStore](https://developer.android.com/privacy-and-security/keystore)。虚构值本身公开且编译进实验，模拟器未证明硬件密钥背书、真实凭据生命周期、卸载恢复或正式安全方案。

## 兼容性诊断与隔离系统对照

评审依据与待确认范围见[Android框架评审](ANDROID_FRAMEWORK_REVIEW.md)。当前页面先运行经典`bootstrap.js`，按本构建需要检查ES模块、安全上下文、随机操作ID、CSS变量与层叠层；缺少能力时显示更新提示、保持按钮禁用，不加载业务实验模块，也不把未读取的账目显示为零。模块加载／解析失败另有错误提示。这不是正式最低版本政策，也没有改写vendor设计快照；正式降级／转译方案仍待验证。

连接已明确转发的隔离WebView后运行`node scripts/check-android-compat.mjs --port <PORT>`。输出`scope: current_webview_only`、实际UA、功能检测与布局宽度；不支持当前构建时仍先输出JSON，再以非零退出。`platform`仅是浏览器报告，不是实际CPU／进程位数证明。源码检查、UA伪装或桌面浏览器不能代替系统对照。诊断只读页面，不写入记录；功能通过后仍需运行HTTP／TLS及离线冷启动验收。

本机新增的隔离AVD为`travelflow_p0_api30`，官方包`system-images;android-30;default;x86_64` revision11。先确认5582与自己的CDP端口未被占用，AVD确属本任务；仅启动该实例，所有相关ADB明确使用`-s emulator-5582`。需要重新准备时，沿用前述独立缓存环境，目标AVD／目录必须不存在，不加`--force`：

```sh
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "system-images;android-30;default;x86_64"
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd --name travelflow_p0_api30 --package "system-images;android-30;default;x86_64" --device pixel_2 --path "$ANDROID_AVD_HOME/travelflow_p0_api30.avd"
"$ANDROID_HOME/emulator/emulator" -avd travelflow_p0_api30 -port 5582 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 1536 -cores 2 -skin 320x640
```

AVD工具本机曾报告缺少镜像`devices.xml`但创建成功；必须核对实际config／启动后的SDK及提供方，不只依赖退出码。API35仍保留在5580，两者不能混用。安装前确认`adb -s emulator-5582 shell getprop ro.build.version.sdk`为30、启动完成，再安装自己生成的debug APK。使用当前PID转发到自己的独立CDP端口（本轮API30为19236、API35为19235），命令与前文相同但显式替换设备序列号；重启后重新获取PID。

镜像自带WebView83可作不支持分支验证：预期诊断缺少`randomUUID`／`cssLayers`，页面明确提示更新、所有按钮禁用且没有加载`probe.js`，原有虚构SQLite不被改写。仅在自己的隔离模拟器中，可用`adb -s emulator-5582 shell cmd package uninstall-system-updates com.android.webview`撤销自己安装的WebView测试更新以重现；不得清除P0应用数据，也不得对真机执行。此命令本机回显Success但退出码为1，应以`dumpsys webviewupdate`中的实际提供方版本确认，不把退出码冒充成功或失败证据。

可用测试更新来源是已有官方API35/default/x86_64镜像中的`/product/app/webview/webview.apk`，本机副本在`~/.cache/travelflow-p0-android/webview124-api35-fixture.apk`。仅从明确的`emulator-5580`用`adb pull`提取到仓库外，以`aapt2 dump badging`核对包`com.android.webview`、版本124.0.6367.219、minSdk26及匹配ABI；先核对目标系统的提供方列表允许这个包，再对明确的`emulator-5582`执行`adb install -r <WEBVIEW_FIXTURE_APK>`。不重签、不改系统白名单、不向宿主安装CA，不将测试内核分发或推荐给真实用户。

更新后强停／启动P0、更新PID与转发，运行诊断、`check-android-tls.mjs`和`check-android-stream.mjs`。再按前文离线步骤显式改用`emulator-5582`及其CDP端口；网络恢复后`--cold-start`不重新准备凭据，预期HTTPS完成，新增与重放记录保持。诊断的layout／visual宽度都记录，窄视口控件应无横向溢出；这不是正式手机交互验收。触摸脚本等待滚动绘制并将布局坐标换算为`visualViewport`坐标，不以JS `.click()`替代原生触摸。

API26/default/x86_64 revision1的本机AVD`travelflow_p0_api26`仅是失败调查缓存，不是可用验收基线：系统允许的提供方为Chrome／Google包，自带与安装的`com.android.webview`不在列表；`dumpsys webviewupdate`无当前提供方，P0在WebView创建前报`MissingWebViewPackageException`。安装包minSdk匹配也不能绕过系统提供方策略。未修改该系统白名单；API24／26已补Google镜像的Chrome69启动保护，新版匹配提供方仍待验证，不据此宣布应用不支持Android7／8。结束后仅关闭自己的实例、服务和端口转发，保留既有记录。

### API33官方提供方组合复现

已有专用AVD `travelflow_p0_provider_source33` 来自官方 `system-images;android-33;google_apis;x86_64` revision17，之前仅用于组件核验；本轮也用于原型运行。沿用本页隔离缓存变量，在确认5558未占用后，启动命令中的AVD改为该名称、端口改为5558；不得清数据或覆盖AVD。先用下节只读工具确认SDK33、启动完成及实际提供方 `com.google.android.webview` 109.0.5414.123，不需要另外安装引擎。

重新生成新TLS证书与原型目录、构建debug，安装到明确的 `emulator-5558`；取当前PID并转发到自己的空闲端口（本轮19238）。依次运行 `check-android-compat.mjs`、`check-android-tls.mjs`、`check-android-stream.mjs`，参数均为 `--port 19238`。按前文断网冷启动步骤操作时，明确替换为该序列号，并每次更新PID／转发；先记录飞行模式原值，结束后恢复。恢复网络后强停重开，运行 `check-android-tls.mjs --port 19238 --cold-start`，确认不重新准备凭据仍可HTTPS，账目不增加。各脚本预期结果与副作用同前文，初始库不要求为空；准确结果见PROJECT_STATUS。

这组同时改变OS与WebView，是组合验收，不是固定引擎的单变量OS对照。`colorMix=false`只记录当前悬停阴影增强缺失，不改vendor快照，也不当作正式交互验收。

### 提供方与候选APK的只读核验

先通过启动命令／AVD配置确认实例确属自己的隔离环境，再运行（序列号仅作示例，不能固定复用）：

```sh
python3 scripts/inspect-android-provider.py --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5558 --expect-sdk 26
python3 scripts/inspect-webview-apk.py --apk /path/to/candidate.apk --aapt2 "$ANDROID_HOME/build-tools/35.0.0/aapt2" --apksigner "$ANDROID_HOME/build-tools/35.0.0/apksigner" --sdk 26
```

提供方工具拒绝非`emulator-N`序列号、非模拟器属性或SDK不符；退出0表示已观察到提供方，1表示明确未就绪，2表示此接口无法判定。API24的空dumpsys应为未知；`configuredProvider`只是配置值，不替代实际状态。`providerSelected=true`也不能代替页面、存储或网络验收。

APK工具需要可运行的JDK及Android Build Tools，执行实际签名校验；输出`minimumSdkMet`只比较最低系统要求，不能当作总体兼容结论。还须核对目标提供方白名单、已有包签名身份／更新资格、ABI、静态库与实际运行。签名有效不等于发布者身份可信，应与可靠来源的预期证书另行比对。工具不安装APK、不获取第三方组件、不调整设备。Google旧系统与官方109候选的实际结果见PROJECT_STATUS新增章节；本机缓存不是其他贡献者必需条件。

已获用户授权，可从第三方镜像站取得原版组件，核验通过后仅用于本项目隔离模拟器。参考APK必须独立取自可信官方镜像，不能用同一镜像站的另一份下载自证身份。API26 Google镜像的 `/system/app/Chrome/Chrome.apk` 已提取到仓库外缓存 `google-chrome69-source26.apk`；实际文件SHA256为 `a1495bdd1c7774a16fc7c41f0dfbec81c2fb7402a35d543c28635cda32dd6b61`，签名证书SHA256为 `f0fd6c5b410f25cb25c3b53346c8972fae30f8ee7411df910480ad6b2d60db83`。复现应从自己明确的同类官方AVD提取，并记录来源，不把网站展示的摘要当作已下载文件的核验。

可选的候选准入检查（参数三项须一起提供）：

```sh
python3 scripts/inspect-webview-apk.py --apk /path/to/candidate.apk --aapt2 "$ANDROID_HOME/build-tools/35.0.0/aapt2" --apksigner "$ANDROID_HOME/build-tools/35.0.0/apksigner" --sdk 26 --reference-apk /path/to/official-chrome.apk --expect-package com.android.chrome --require-abi x86_64
```

`candidateCheck.passed`与退出0仅表示包名、同包签名集合、SDK上下界、指定ABI、WebView库声明及没有未解决静态库依赖都满足本工具条件；拒绝时输出逐项布尔值并退出1。签名集合严格相同，不自动接受密钥轮换。纯元数据模式不变，仍可报告不匹配条件供调查。此工具不检查系统白名单、更新版本码资格、完整split集合、引擎功能或真正运行；即使69样本元数据通过，当前原型仍缺少页面能力。带静态库的候选保守拒绝，不为其自动下载／安装依赖。下载的HTML／错误页或签名无效的APK直接失败，不会得到准入结果。

此前APKMirror／APKPure／Softpedia下载访问返回403，正常浏览器同样受阻；Uptodown的已检查119及其他候选页面仅提供ARM变体，没有取得可用于现有x86隔离AVD的候选。不要把页面架构描述写成已核验APK，也不要修改包名／重签／系统白名单来绕过。没有需要用户再次确认的来源权限；后续已取得匹配的x86原版文件并运行，见下一小节。

### API24／26的32位Chrome119组合复现

已核验的历史测试组件来自[候选页面](https://apk.gold/download?file_id=2753516/chrome)的正常下载入口，本机仓库外副本为 `~/.cache/travelflow-p0-android/google-chrome119-193-x86-fixture.apk`。实际文件191313115字节，SHA256 `d88b3e77e8aa6c98d07bdad4099caf22d36a495312116549e1fde1aad6ad2f14`；版本119.0.6045.193／code604519326，minSdk24／maxSdk28，仅x86，签名证书与上述官方Chrome69基准一致。站点URL不是真实性证明，下载文件仍须先执行准入检查；页面及下载地址可能变化，摘要不同的文件不得沿用本次结论。不提交或向用户分发APK，不将历史引擎推荐给真实设备。

关键前提是**应用进程与引擎ABI匹配**。不能因为 `ro.product.cpu.abilist` 同时列x86_64／x86就选32位组件：实际64位P0加载这份库已失败。确认应用运行的位数可执行 `adb -s <明确序列号> shell run-as org.travelflow.p0 readlink /proc/<当前PID>/exe`，本轮32位组合应为 `/system/bin/app_process32`；`navigator.platform`不能替代此证据。64位进程的准入应指定 `--require-abi x86_64`，会拒绝此文件，不能为“通过”而更改要求。

本机新建官方包与专用AVD：

| SDK包 | revision | AVD | 本轮端口 |
| --- | --- | --- | --- |
| `system-images;android-24;google_apis;x86` | 27 | `travelflow_p0_api24_google_x86` | 5560 |
| `system-images;android-26;google_apis;x86` | 16 | `travelflow_p0_api26_google_x86` | 5558 |

沿用本页SDK缓存环境，用sdkmanager安装表中包，缺少AVD时按前述avdmanager流程创建独立名称／新目录，不加force；现有AVD复用、不清数据。启动前确认端口空闲及config指向表中包，启动后核对SDK、启动完成、系统ABI仅x86。对候选分别运行上节准入命令，`--sdk`改为24／26、`--require-abi x86`；参考APK必须保留官方来源。通过后才向明确设备执行 `adb -s <序列号> install -r <候选APK>`，再安装自己独立构建且测试CA仍有效的debug原型。API26的dumpsys应选中Chrome119；API24空dumpsys仍报告未知，不把配置值替代实际运行。

启动P0、取得PID／核对进程为32位、转发CDP。依次执行能力、TLS、HTTP脚本（API26本轮19238，API24本轮19239）；预期页面实际Chrome119、原生桥就绪及三脚本通过，初始金额不限，已有虚构记录保留。新AVD本轮各从0到123、246分，不要求后续重新从零开始。

API24／26的 `cmd connectivity` 没有shell实现，且可能退出0；不能仅看退出码判断切网。直接发送飞行模式广播被系统拒绝，本轮未用root绕过。断网验收改用系统设置UI：先记录 `settings get global airplane_mode_on` 原值，执行 `adb -s <序列号> shell am start -a android.settings.AIRPLANE_MODE_SETTINGS`；用 `uiautomator dump` 检查当前“Airplane mode”行和开关真实状态，再通过该明确设备的 `input tap` 触摸实际坐标，等待设置值变为1。不可复用其他系统的坐标，也不可仅写global设置值冒充网络已关闭。

确认状态1后强停冷启动P0，更新PID／转发，运行 `check-android-stream.mjs --port <端口> --offline`；应网络失败、余额保留、新增123分且重放不增加。再从同一系统设置UI恢复原值（本轮为0），确认后强停冷启动、更新PID／转发，运行 `check-android-tls.mjs --port <端口> --cold-start`，应不重新准备凭据就成功HTTPS，记录数／金额前后一致。本轮各最终3条／369分。设置值、网络失败与冷启动后的行为分别核对，不把服务停止当真实断网。结束后移除自己创建的uiautomator暂存文件、转发、测试服务及实例；保留AVD数据。更多结果与未验边界见PROJECT_STATUS。

### 本地触摸与强停恢复验收

新增入口只连接操作者已经明确转发的P0 WebView，不发现／选择ADB设备，不安装APK，不改变网络：

```sh
node scripts/check-android-local.mjs --port <CDP端口>
node scripts/check-android-local.mjs --port <CDP端口> --expect-local <记录数> <整数分>
```

第一条会真实触摸保存和同ID重放：原记录逐条保持，只追加一条123分，重放整个原生快照不变；输出前后计数／金额，不输出记录ID。随后仅强停、重开自己的P0应用，更新PID与转发，再用第二条只读核对预期持久结果。原库不要求为空，禁止为固定预期清数据。当前脚本仅验证固定虚构表，不是正式消费、日期、迁移或同步验收。

共享CDP驱动在发送touchend后等待目标按钮的可信click事件，错目标或3秒内未收到点击均失败，并清除临时监听器／回执。API36首次执行时观测到约300毫秒的click延迟，旧脚本曾读到旧终态并提前滚动；等待真实事件后完整TLS／HTTP通过。不得用JS `.click()`、任意补眠或降低取消／超时要求制造通过。

### API36官方模拟器复现

官方包 `system-images;android-36;google_apis;x86_64` revision7，本机专用AVD `travelflow_p0_api36_google`。按前文SDK／AVD流程准备或复用，不覆盖、不清数据；本轮空闲端口5558、CDP19238。实际Google WebView133.0.6943.137，`app_process64`、内核和提供方为x86_64；ABI列表中的arm64-v8a不代表ARM64真机证据。独立原型的targetSdk为36，本轮复用此前已构建且测试CA仍有效的APK；过期后须按前文重新准备。

确认归属、SDK36、启动完成及当前提供方后，安装自建debug、取PID并转发，依次运行能力／TLS／HTTP完整脚本。确认飞行模式原值后，用实际支持的 `cmd connectivity airplane-mode enable` 切换并核对状态为1；强停冷启动、更新PID／转发，再运行HTTP脚本 `--offline`。恢复原值0，强停冷启动、更新转发，TLS脚本 `--cold-start` 应读取已有虚构凭据成功。最后可跑上述本地触摸与只读强停检查；本轮最终4条／492分。具体覆盖与安全区早期日志边界见PROJECT_STATUS，不把此组合当全部Android16设备或正式交互验收。

### 用户指定USB真机的本地验收边界

AGENTS默认仅限隔离模拟器。用户本轮明确允许对已识别ELI-AN00手机安装现有独立APK，仅做启动／本地固定记录／重放／本包强停恢复；授权不扩展到其他设备、其他用户空间、联网、凭据、飞行模式、WebView更新或其他应用数据。新会话先只读识别并核对已有授权，不能把型号当唯一设备标识，也不把设备序列号写入Git。若没有对应授权，仍按模拟器边界执行；不要把本次例外改成全局真机权限。

本轮通过Windows既有ADB服务发现已授权设备，复用该服务对应的adb.exe与服务端口（不使用别的版本触发服务重启），未改全局ADB。先记录 `am get-current-user`，包查询用 `pm list packages --user <用户ID> org.travelflow.p0`，安装新包应显式指定该用户并拒绝覆盖已有包；启动／强停同样显式 `--user <用户ID>`。OEM受保护空间的访问错误不能通过root／遍历绕过，也不能把命令退出0当查询可靠。

只安装已审阅的独立debug APK；本轮SHA256 `f27e4d10632a705bde56353f1c5f1496ad505a6b200ea7150ea3afd5faaba0ae`，仅INTERNET及本包内部动态接收器权限，应用ID `org.travelflow.p0`，不是正式签名发布。重新生成／构建会改变摘要，应重新核对来源和打包策略，不能照搬本值。现有APK联网入口固定10.0.2.2，仅用于模拟器；真机本轮只使用本地按钮。

应用启动后，取本包当前PID，以 `run-as org.travelflow.p0 --user <用户ID> readlink /proc/<PID>/exe` 核对位数，结合 `uname -m` 和系统ABI；本轮手机为aarch64／app_process64。为该明确序列号创建自己的CDP转发，首次用 `forward --no-rebind tcp:<端口> localabstract:webview_devtools_remote_<PID>` 防止覆盖既有端口。Windows ADB的转发位于Windows localhost，本轮用Windows Node22+运行同一仓库脚本（必要时使用WSL仓库的UNC路径），不将其误当WSL localhost；无需重启用户ADB或映射手机存储。

先跑能力诊断，再跑本地触摸脚本。只强停／启动该用户下本包，更新PID／自己的转发，用 `--expect-local` 只读验证。此手机本轮1条／123分，网络／凭据未验证，不调用对应脚本或按钮。验收后移除本轮转发、结束本包调试，保留应用与虚构记录，不卸载／清数据。后续先准备可审阅的USB本地测试对端配置，再另行明确真机网络／凭据操作范围；不能直接扩大本次授权。

### USB回环配置的生成、审查与验收

当前生成器仅接受 `--target emulator|usb`：默认emulator为10.0.2.2，usb为127.0.0.1；没有任意地址参数。两种工程都生成ProbeEndpoint.java及probe-endpoint.js，原生流式和普通HTTP测试共享固定目标。新版HTTP验收脚本需要这些资产，应匹配新生成APK；不要直接套到旧安装包。证书fixture的host须匹配target，旧v1无host字段仅视为emulator；混用在创建工程／启动服务前拒绝。

准备仓库外的新目录（不覆盖），USB示例：

```sh
python3 scripts/prepare-probe-tls.py --output /tmp/travelflow-usb-tls --target usb
node scripts/prepare-android-probe.mjs --output /tmp/travelflow-usb-app --tls-fixtures /tmp/travelflow-usb-tls --target usb
python3 scripts/android_probe_service.py --tls-fixtures /tmp/travelflow-usb-tls --target usb
```

emulator配置同样可显式传 `--target emulator`，或沿用默认命令。证书只含对应测试IP，host不匹配／不信任／过期端口保持独立；服务307目标也采用同一固定IP。服务始终仅监听宿主127.0.0.1的18510–18515，不读取.env。测试CA仅进debug的唯一对应域，release只信任系统CA并拒绝明文；不向手机或宿主系统安装CA。生成后按前文构建debug／unsigned release及完整debug lint，再给 `check-probe-apk.py` 增加同一 `--target usb`。该检查解析实际打包XML层级及资产：不能只凭某个字符串存在就判断CA范围，测试CA若移到base-config全域信任也须拒绝。

**反向转发必须明确回环绑定。** 本轮API36实测，标准 `adb reverse tcp:PORT tcp:PORT` 监听通配地址；地址参数又被客户端校验拒绝。新增工具通过已有ADB本机服务请求标准协议的localhost监听，依据[AOSP socket_spec_listen](https://android.googlesource.com/platform/packages/modules/adb/+/30e74acef93318b07a2de7ffca5086dde868ad01/socket_spec.cpp)。不修改ADB、不绕过设备授权、不启动或重启服务；先确认设备归属、授权和已有服务端口，再执行：

```sh
node scripts/check-probe-reverse.mjs
node scripts/manage-probe-reverse.mjs --server-port <已有ADB端口> --serial <明确序列号> --action add
node scripts/manage-probe-reverse.mjs --server-port <同一端口> --serial <同一序列号> --action remove
```

只处理18510–18515，`--probe-port 18510`可限定其中一项；无默认设备或服务端口，不提供任意目标主机。add不覆盖已有映射，部分失败只回滚本次新增；remove仅用于自己已创建的本轮映射，不是全设备清理。adbd列表中名字会规范化为tcp:PORT，实际监听应以设备的ss等只读结果核对为127.0.0.1，不能由列表名称推断；不支持明确localhost的设备不得退回通配绑定。确认失败／端口占用时停止并排查，不改全局ADB、系统网络或防火墙。协议检查器只启动本机模拟对端，CI不会通过它操作设备。

Windows ADB服务的目标tcp:PORT指向Windows localhost；使用Windows Node运行管理／验收脚本，并先确认Windows的127.0.0.1测试端口可达WSL服务。Linux模拟器则使用Linux Node和本机ADB服务。不会因为USB转发而自动取得真机联网权限：当前已识别手机原授权仍仅本地路径；扩大到更新APK、转发与虚构凭据测试必须先给用户可审阅的包和范围。

在已授权的隔离模拟器，可先安装USB debug并创建这六项映射，转发P0 WebView，依次跑能力、完整TLS与HTTP脚本。移除自己创建的HTTP映射后，强停冷启动并跑HTTP `--offline`，预期请求失败而本地新增／重放仍有效；这里证明映射缺失，不证明飞行模式。恢复映射、再强停冷启动，TLS `--cold-start`应不重新准备凭据就成功，账目保持。不要为期望值清数据。结束后只移除本轮反向映射／CDP转发并停止自己的测试服务，设备网络设置保持原状。

本轮候选USB debug路径 `/tmp/travelflow-p0-app-usbprep/android/app/build/outputs/apk/debug/app-debug.apk`，SHA256 `e9a9de4ec3acbf81d3369dc92c4d02a0d9f8218f6e0c793d57214504757ff815`；需重新生成时重新核对摘要和权限，不能要求临时路径永久存在。实际构建、负例、模拟器8条／984分及尚未执行的真机范围见PROJECT_STATUS。未来真实供应商／凭据／跨端同步接口仍不由此探针决定。

## 契约与设计快照更新

权威数据契约在电脑仓库contracts，移动侧vendor/contracts保存固定版本。根目录执行 `node scripts/import-contract.mjs --source <电脑仓库Git副本> --commit <完整40位提交SHA>`，仅显式更新时需要此副本；导入前验证上游摘要，再运行三项检查、审阅差异并提交。当前导入器只支持实验ledger-v1，不是未来同步协议协商工具。既有契约版本不可原地改写；新规则需先由两端评审版本与迁移。

vendor/design为固定提交样式快照，更新时逐文件对照上游，更新ORIGIN摘要并审阅主题／按钮状态；不能把复制等同实时共享。src/domain/ledger.ts由移动端维护，受共享样例约束，不会自动跟随桌面Python实现。


## 下一项调查入口与跨仓协作

本仓库下一项由[移动路线P0](PRODUCT_ROADMAP.md)安排。已核对`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/CapacitorHttp.java`及同目录下的`util/HttpRequestHandler.java`：8.6.0实现读取完整响应后才resolve，公开请求接口没有单请求取消；销毁插件时的disconnect不等于用户可取消请求。原生适配探针已有上面的分块／取消／读取与TLS连接超时／总时限／显式恢复、HTTPS与虚构凭据验收入口，实际证据见PROJECT_STATUS；这只证明此环境中自建适配可行，不正式选定框架。框架与兼容性评审已形成，见ANDROID_FRAMEWORK_REVIEW；下一项按用户确认的旧系统＋可更新WebView优先顺序，补API24／26的匹配提供方组合，再完善系统／ABI边界。TCP／DNS取消和真实凭据／供应商仍未覆盖。参考[官方HTTP接口](https://capacitorjs.com/docs/apis/http)与[Android连接说明](https://developer.android.com/reference/java/net/HttpURLConnection)，仍以固定依赖源码和实际运行结果为准。

电脑端由另一会话负责。完整业务清单与保护约束见[接口能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CAPABILITIES.md)、[跨端总计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CONTINUITY_PLAN.md)。本地读写离线完整、联网后手机独立调用在线服务、双方在线直接同步已确定；无常驻应用服务器，本里程碑不加入云存储，第三方账号／中继与具体连接工具尚未批准。不能按个人机型缩窄开源兼容范围，也不因旅中优先删减规划／高级工程／回顾。

移动侧可自主验证平台适配；需要改变数据含义、共享契约或电脑配合时，先形成带版本的规格差异、需要电脑侧提供的接口和联合验收条件，交用户协调两会话，不能直接改电脑仓库或默认其会立即升级。契约仅导入已审阅的固定提交，升级后分别记录两端支持版本；不要把凭据加入业务同步或公开调试日志。设计快照、API矩阵是参考资料，不是移动功能已获用户验收的证明。
