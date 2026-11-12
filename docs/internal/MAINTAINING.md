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

应用启动命令为 `adb -s emulator-5580 shell am start -n org.travelflow.p0/.MainActivity`，强停用 `adb -s emulator-5580 shell am force-stop org.travelflow.p0`；这里adb指上面SDK的platform-tools/adb，未加入PATH时使用完整路径。默认安装APK、切换网络、强停都仅限隔离模拟器；指定USB手机的明确授权例外见后文，切网仍不在真机授权内。SDK／生成工程路径可能在机器清理后消失，应按文档重新准备，不能把旧/tmp路径存在当作验收前提。

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

API26/default/x86_64 revision1的本机AVD`travelflow_p0_api26`仅是失败调查缓存，不是可用验收基线：系统允许的提供方为Chrome／Google包，自带与安装的`com.android.webview`不在列表；`dumpsys webviewupdate`无当前提供方，P0在WebView创建前报`MissingWebViewPackageException`。安装包minSdk匹配也不能绕过系统提供方策略。未修改该系统白名单；API24／26已补Google镜像的Chrome69启动保护及后述Chrome119的32／64位匹配路径，不据此宣布应用不支持Android7／8。结束后仅关闭自己的实例、服务和端口转发，保留既有记录。

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

### API24／26的64位Chrome119组合复现

2026-11-12沿用官方Google APIs/x86_64专用AVD：`travelflow_p0_api24_google`为revision27，`travelflow_p0_api26_google`为revision16。本轮分别5560／19239、5558／19238；先确认端口空闲与实例归属，再按前文启动，不清库、不覆盖AVD。这是64位组合，对应32位实例及数据继续保留。

组件来自[Downzen119候选页](https://downzen.com/en/android/chrome-browser-google/download/11906045193/)的x86_64正常下载入口，仓库外缓存为`~/.cache/travelflow-p0-android/google-chrome119-193-x64-fixture.apks`及`chrome119-193-x64-splits/`。APKS只是ZIP容器，不安装网站推荐的额外安装器；先检查下载完整性与路径，再只提取其中8个APK到新目录，不执行容器内容。容器／主包摘要、精确分包集合及来源结果见PROJECT_STATUS，短期签名下载URL不写入仓库。下载HTML、403响应或未完成文件不能继续安装。

主包沿前述准入命令检查，指定`--require-abi x86_64`，API24／26分别核对SDK；该主包versionCode604519327、minSdk24／maxSdk28，含两种ABI且没有Trichrome静态库依赖。必须另对8个APK逐个执行`apksigner verify --print-certs`，只比较`Signer #... certificate SHA-256 digest`（不要误把Source Stamp证书当应用签名）；均须与官方Chrome69同包签名一致。用aapt2核对相同包名／versionCode及唯一split名称，检查ZIP完整性，保留原始签名。不因主包准入通过便假定其他分包有效／齐全，也不从其他版本混入分包。

核验完成后，在已确认的目标实例运行（目录只含本次8份已核验文件）：

```sh
"$ANDROID_HOME/platform-tools/adb" -s <明确序列号> install-multiple -r /path/to/verified-splits/*.apk
"$ANDROID_HOME/platform-tools/adb" -s <同一序列号> shell pm path com.android.chrome
```

API26本轮安装成功并选中119。API24的ADB提交返回异常，但系统PackageManager日志显示已完成，pm path包含base和七个split，随后完整原型路径通过；不能只凭命令异常反复重装，也不能只凭包列表算运行通过。API24的提供方dumpsys仍为空，工具报告未知，实际加载由页面和原生进程另证。用`run-as org.travelflow.p0 readlink /proc/<当前PID>/exe`确认app_process64，结合内核／提供方库；API26的navigator.platform显示i686也不能代替此检查。

本轮11月9日测试证书已过期，须生成新的两天TLS材料和独立emulator工程，按前文构建debug／unsigned release、完整lint及实际打包检查；本轮生成目录为`/tmp/travelflow-p0-{tls,app}-20261112-x64`，临时目录不是接续前提。安装新的原型debug后，按当前PID转发CDP，依次运行能力、完整TLS、完整HTTP脚本。再沿32位小节的设置UI流程真实切换飞行模式、强停冷启动及`--offline`；不要套用坐标，API24与26的设置布局不同，触摸后要等实际状态并核对。恢复原值后再强停冷启动，TLS `--cold-start`必须不重新准备凭据而成功、本地不增记录。

两组本轮各从0到TLS后123、HTTP后246、断网新增／重放后369分，冷读前后3条／369分保持；再次复验须从已有记录计算，不能清库凑期望值。可用`check-android-local.mjs --port <端口> --expect-local 3 369`复核本轮持久结果；该只读断言不发网络请求。结束后确认飞行模式恢复原值、移除自己的UI暂存文件和转发、停止自己的服务与实例，保留数据。不要把历史Chrome119安装到用户手机，或把两个模拟器结果当所有旧ARM设备已支持。

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

### 用户指定USB真机的授权与本地验收

AGENTS默认仅限隔离模拟器。用户最初批准已识别ELI-AN00手机的安装／本地记录／重放／本包强停恢复；审阅USB候选包与范围后，又明确允许继续该给定USB手机的测试，已完成本包更新、USB回环虚构HTTP／TLS及公开虚构凭据验收。授权不扩展到其他设备、其他用户空间、真实供应商／密钥、飞行模式、WebView更新或其他应用数据。新会话先只读识别并核对已有授权，不能把型号当唯一设备标识，也不把设备序列号写入Git。若没有对应授权，仍按模拟器边界执行；不要把本次例外改成全局真机权限。

本轮通过Windows既有ADB服务发现已授权设备，复用该服务对应的adb.exe与服务端口（不使用别的版本触发服务重启），未改全局ADB。先记录 `am get-current-user`，包查询用 `pm list packages --user <用户ID> org.travelflow.p0`，首次安装应显式指定该用户并拒绝覆盖来源未知的已有包；已核对为本实验包的授权更新用`install -r --user <用户ID> <APK>`，先核对签名与保存原生账本摘要，更新后确认原记录／金额不变；启动／强停同样显式 `--user <用户ID>`。OEM受保护空间的访问错误不能通过root／遍历绕过，也不能把命令退出0当查询可靠。

只安装已审阅的独立debug APK；首轮本地包SHA256 `f27e4d10632a705bde56353f1c5f1496ad505a6b200ea7150ea3afd5faaba0ae`，仅INTERNET及本包内部动态接收器权限，应用ID `org.travelflow.p0`，不是正式签名发布。重新生成／构建会改变摘要，应重新核对来源和打包策略，不能照搬本值。该首轮包联网入口固定10.0.2.2，仅用于模拟器；后续真机网络验收须使用下节USB配置包，不对旧包运行新版HTTP脚本。

应用启动后，取本包当前PID，以 `run-as org.travelflow.p0 --user <用户ID> readlink /proc/<PID>/exe` 核对位数，结合 `uname -m` 和系统ABI；本轮手机为aarch64／app_process64。为该明确序列号创建自己的CDP转发，首次用 `forward --no-rebind tcp:<端口> localabstract:webview_devtools_remote_<PID>` 防止覆盖既有端口。Windows ADB的转发位于Windows localhost，本轮用Windows Node22+运行同一仓库脚本（必要时使用WSL仓库的UNC路径），不将其误当WSL localhost；无需重启用户ADB或映射手机存储。

先跑能力诊断，再跑本地触摸脚本。只强停／启动该用户下本包，更新PID／自己的转发，用 `--expect-local` 只读验证。首轮手机1条／123分；后续USB验收至4条／492分，具体网络与凭据覆盖见下节和PROJECT_STATUS。验收后移除本轮转发、结束本包调试，保留应用与虚构记录，不卸载／清数据。不得将已有范围扩大为其他设备或真实业务测试。

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

Windows ADB服务的目标tcp:PORT指向Windows localhost；使用Windows Node运行管理／验收脚本，并先确认Windows的127.0.0.1测试端口可达WSL服务。Linux模拟器则使用Linux Node和本机ADB服务。USB转发本身不授予真机权限；本项目给定手机的更新、回环虚构服务与公开虚构凭据范围现已明确获准，其他设备仍需单独明确授权。

在隔离模拟器或明确获准的指定USB手机，可先安装／保留数据更新USB debug并创建这六项映射，转发P0 WebView，依次跑能力、完整TLS与HTTP脚本。移除自己创建的HTTP映射后，强停冷启动并跑HTTP `--offline`，预期请求失败而本地新增／重放仍有效；这里证明映射缺失，不证明飞行模式。恢复映射、再强停冷启动，TLS `--cold-start`应不重新准备凭据就成功，账目保持。不要为期望值清数据。结束后只移除本轮反向映射／CDP转发并停止自己的测试服务，设备网络设置保持原状。

指定手机的执行顺序为：更新前／后核对原生账本、能力诊断、完整TLS、完整HTTP、移除HTTP映射后的强停／`--offline`、恢复映射后的强停／TLS `--cold-start`。每次重启都重新取PID并只更新自己的CDP转发。所有`adb`显式带已有服务端口、设备序列号，安装／启动／强停限定当前用户；脚本由ADB所在Windows环境的Node22+运行。初始账本不要求为空，完整TLS与HTTP各新增123分，映射失败脚本再新增123分，重放不重复增加；冷读不增记录。本轮从1／123到4／492。若CDP连接挂起，先重新启动本包到前台并核对PID／转发，不重启全局ADB，也不操作锁屏或其他应用。

最终凭据冷读通过后，通过「移除虚构凭据」只清理专用别名和prefs内容，运行TLS `--expect-credential-failure`应报CREDENTIAL_UNAVAILABLE、服务无HTTP请求且本地记录不变；再用本地脚本`--expect-local <条数> <分>`只读确认。指定手机结束时保留4条／492分，专用凭据已移除，下次完整测试需重新准备。清理只针对本轮创建的六项反向映射、CDP转发、服务与本包进程，不清数据、不卸载、不重启ADB、不修改手机网络。

本轮候选USB debug路径 `/tmp/travelflow-p0-app-usbprep/android/app/build/outputs/apk/debug/app-debug.apk`，SHA256 `e9a9de4ec3acbf81d3369dc92c4d02a0d9f8218f6e0c793d57214504757ff815`；需重新生成时重新核对摘要和权限，不能要求临时路径永久存在。实际构建、负例、模拟器8条／984分及真机4条／492分的已执行范围与限制见PROJECT_STATUS。未来真实供应商／凭据／跨端同步接口仍不由此探针决定。

## SYN／DNS故障实验（仅专用隔离AVD）

这是诊断入口，不是正式业务或真机步骤。需要Node22+、Python3.9+、已构建的最新emulator debug APK、可root的官方隔离镜像及其iptables。先按前文创建全新专用AVD，名称以`travelflow_p0_connect`开头，不复用用户手机或其他任务实例；本机已有`travelflow_p0_connect35`（API35/default/x86_64）和`travelflow_p0_connect24`（API24/Google APIs/x86_64，使用已核验Chrome119分包）。启动选项添加`-dns-server 127.0.0.1`，只影响此实例，依据[官方DNS配置](https://developer.android.com/studio/run/emulator-networking-dns)。不要修改宿主resolv.conf、系统DNS或防火墙。

先只读核对明确实例的`ro.kernel.qemu=1`、SDK、boot完成及AVD名（新系统为ro.boot.qemu.avd_name，API24为ro.kernel.qemu.avd_name）。确认后仅对该序列号执行`adb -s <序列号> root`及wait-for-device；不重启全局ADB，不修改应用UID。安装最新独立emulator debug；API24须先沿前述步骤验证匹配引擎。例：

```sh
PYTHONOPTIMIZE=1 python3 scripts/check-connect-fixture.py
python3 scripts/android_probe_service.py --tls-fixtures /path/to/fresh-emulator-tls
# 另一个终端；替换为已核对且确属本任务的序列号、专用AVD、SDK及空闲CDP端口
python3 scripts/run-android-connect.py --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5558 --expect-avd travelflow_p0_connect35 --expect-sdk 35 --port 19238
```

控制器不会自动root或选择设备；错误设备／AVD／SDK／用户／非debug／非root、已占用映射或专用链均在写入前拒绝，Python优化模式也不会关闭这些检查。工具不安装APK、不清库、不启动模拟器。既有HTTP对端18510须先运行；另需本机回环UDP18516及HTTP18517空闲，不允许通配绑定。API24例改为明确的5560／travelflow_p0_connect24／24／19239；端口只是本轮选择，接手要重新核对。

工具依次冷启动正常HTTP、SYN丢包、DNS取消、DNS总时限及恢复后的正常HTTP，每次按当前PID转发自己的CDP。SYN规则只匹配本包UID及10.0.2.2:18510的新建连接，须先实际看到丢包计数与内核SYN_SENT；DNS仅将此AVD的10.0.2.3:53 UDP／TCP转发到10.0.2.2:18516的宿主回环对端，看到固定虚构名A／AAAA查询才取消。DNS释放时仅返回NXDOMAIN，不访问真实DNS、不发鉴权。终态后核对SYN_SENT已关闭、无追加事件、账本保留和幂等重放；finally只删除本轮新增跳转／专用链、转发并强停本包，已有链不清理。

**读结果时分开两项：**`fixtureAssertionsPassed=true`证明实验和数据保护断言通过；`promptCancellationPassed`才表示1秒内真正取消是否满足。原ProbeStream对照在API24／35的SYN为true、DNS为false；DNS在挂起超过1.2秒时仍无终态，释放后才结束。dns-deadline在越过原6000ms阈值、额外等待6500ms后仍无终态，不能将DEADLINE信号当线程已退出。实验刻意释放查询以结束诊断，没有测出默认DNS最坏等待时间。控制器返回0不代表原传输所有取消目标通过；不得为绿灯改阈值或提前伪造终态。

每次完整诊断在SYN与DNS取消期间各追加123分并重放，正常基线与deadline不写账本；已有记录逐条保护。初始金额不要求0，失败后的已保存记录也不能清掉；本轮具体计数、规则错误与完整TLS／HTTP回归见PROJECT_STATUS。结束后确认专用链不存在、自己的转发与对端停止，再关闭自己的AVD，保留数据；root adbd只在该隔离实例存活期间使用。

DNS入口位于原ProbeStream，但仅debug＋emulator可用，固定随机`.p0-dns.invalid`后缀且不接收业务URL；USB／release返回INVALID_OPTIONS，不添加凭据。生成器开启BuildConfig，编译期release移除DNS目标字符串，check-probe-apk.py对实际release DEX再检查；debug CA仍仅原固定IP。不要将本实验配置安装到用户手机或据此调用真实供应商。

## 可选可取消解析与客户端对照

这是上一节的独立debug对照，原页面按钮仍调用ProbeStream。只有显式`--transport-probe okhttp`才加入ProbeAsyncStream与固定OkHttp Android5.3.2、MiniDNS core1.1.1 debug依赖及许可／NOTICE，默认emulator、usb和所有release不加入实验客户端；不是正式选型。使用上一节两台明确的专用AVD、DNS启动参数、root adbd及既有数据，不覆盖或清库。

必须生成匹配的独立证书和工程，目录应不存在：

```sh
python3 scripts/prepare-probe-tls.py --output /tmp/travelflow-async-tls --transport-probe okhttp
node scripts/prepare-android-probe.mjs --output /tmp/travelflow-async-app --tls-fixtures /tmp/travelflow-async-tls --transport-probe okhttp
```

仍按前文JDK21／SDK36流程构建debug、unsigned release和完整debug lint。打包检查命令额外添加`--transport-probe okhttp`，对端使用该新TLS目录启动。此配置仅emulator可用，usb＋okhttp或证书／工程配置混用在创建目标目录前拒绝；不要用上轮默认CA目录假装匹配。

debug仅在原IP域之外增加精确`valid.p0-dns.invalid`的测试CA信任，明确includeSubdomains=false、cleartextTrafficPermitted=false；叶证书增加该DNS SAN，错误／过期／不信任证书仍独立。release只保留系统CA和禁明文，实际APK还检查实验DNS、插件、OkHttp／MiniDNS客户端不进入release；ACCESS_NETWORK_STATE仅可选debug声明。许可与NOTICE只在debug资产中，未注入系统CA。扩大DNS子域信任的实际APK负例已被拒绝、未安装。恢复APK因增量重打包布局变化而摘要不同，已核对全部条目内容及同一有效签名；实际运行包与恢复包摘要分别见PROJECT_STATUS。

向已核对的专用AVD保留数据更新安装debug，保持上一节的基础回显／TLS服务运行，然后：

```sh
python3 scripts/run-android-connect.py --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5558 --expect-avd travelflow_p0_connect35 --expect-sdk 35 --port 19238 --client okhttp
```

API24替换为其明确实例5560、travelflow_p0_connect24、SDK24及端口19239。完整对照包含普通HTTP、SYN、保留系统解析的对照、自动可取消解析、DNS总时限、域名HTTPS／流式边界及恢复后的普通HTTP。`dns-system`预期保留已知取消不足，不能把`fixtureAssertionsPassed`当所有分支取消通过；自动分支的DNS取消必须一秒内，6000ms阈值后6500ms检查时须已发终态。自动分支资源计数归零后、DNS对端尚未释放时，还须成功启动并完成新HTTP请求。每组完整诊断在三次取消实验各追加123分／幂等重放，初始账本不限；原条目须保持。

API29+自动分支使用平台DnsResolver与CancellationSignal；旧分支现在由MiniDNS core解码A／AAAA、CNAME及TCP帧，本项目持有可关闭UDP／TCP I/O，替换上轮固定A报文实验。每次请求从当前Network的LinkProperties读取DNS服务器，并绑定DNS／HTTP套接字，平台查询也传同一Network；没有公共DNS回退。CNAME循环最多8跳，错误ID／问题不采纳，不缓存或补搜索域。外层6000ms总时限关闭实际资源后才发终态。固定域直连返回10.0.2.2，AAAA默认无记录；随机tf前缀继续挂起，其他名字立即否定、不转发。URL保留原域名，TLS仍使用平台信任与默认主机名校验；别名不增加CA信任域。

这仍不是完整生产DNS实现：缓存、搜索域、多服务器失败预算、真实IPv6网络、代理／Private DNS、VPN及网络变化需要后续评审和验证。可选客户端遇代理或活动Private DNS明确拒绝，不能绕开系统配置；Private DNS拒绝尚未实测。不要把这个实验限制写成用户已接受的正式支持范围。

只复验凭据／TLS／SSE的增补，可在完整命令末尾加`--case tls`，不新增账目；会移除／重建专用公开虚构凭据。预期缺失凭据不发请求、401／307／503、证书拒绝、分块／截断／Last-Event-ID恢复、握手和读取取消／超时、总时限、立即取消、并发和错误ID拒绝均满足断言，请求结束后工作项／解析／DNS套接字／HTTP调用／连接计数归零。它只证明固定对端上的组合能力；真实供应商、代理、切网和正式凭据策略仍未完成。

本轮最终专用API35为10条／1230分，API24为7条／861分，具体来源及原客户端回归见PROJECT_STATUS；再次复验按已有数据计算，不能清库凑期望值。最后按上一节清理本轮链、自己的转发及服务，关闭自己的实例，保留数据。若需再次生成，临时目录和两天证书都不作为接续前提。

## 契约与设计快照更新

权威数据契约在电脑仓库contracts，移动侧vendor/contracts保存固定版本。根目录执行 `node scripts/import-contract.mjs --source <电脑仓库Git副本> --commit <完整40位提交SHA>`，仅显式更新时需要此副本；导入前验证上游摘要，再运行三项检查、审阅差异并提交。当前导入器只支持实验ledger-v1，不是未来同步协议协商工具。既有契约版本不可原地改写；新规则需先由两端评审版本与迁移。

vendor/design为固定提交样式快照，更新时逐文件对照上游，更新ORIGIN摘要并审阅主题／按钮状态；不能把复制等同实时共享。src/domain/ledger.ts由移动端维护，受共享样例约束，不会自动跟随桌面Python实现。



## 旧系统DNS协议与代理拒绝的增补验收

前提仍是上一节已匹配的可选工程／TLS材料及专用AVD。JVM协议检查只需要JDK21、Python3.9+和生成工程解析的MiniDNS Jar，不启动ADB、不访问公共DNS。先在生成工程的android目录运行`:app:exportDnsCodec`，再回仓库执行（`$PROBE_APP`自行设为仓库外的该工程路径，Java命令使用JDK21）：

```sh
python3 scripts/check-dns-codec.py --jar "$PROBE_APP/android/app/build/probe-deps/minidns-core-1.1.1.jar"
```

预期`passed=true`且12组通过：A、CNAME、UDP转TCP、AAAA解码、污染地址的错误ID／问题响应过滤、畸形包、循环、NXDOMAIN、截断TCP及UDP／TCP实际取消。TCP取消还须由对端观察关闭，不能只看Future状态。它不证明Android或真实IPv6路由；临时class文件和端口自动清理。`PYTHONOPTIMIZE=1 python3 scripts/check-connect-fixture.py`另执行5项本机协议／设备拒绝／监听独占及同端口重启检查。

完整`--client okhttp`在API24自动加入协议组；API29+使用平台分支，不用这组测试冒充旧分支。只重跑协议组时：

```sh
python3 scripts/run-android-connect.py --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5560 --expect-avd travelflow_p0_connect24 --expect-sdk 24 --port 19239 --client okhttp --case codec
```

仍需已核对的root adbd、`-dns-server 127.0.0.1`启动参数和匹配TLS对端。仅此AVD的UDP／TCP53经专用链到宿主127.0.0.1:18516，不修改宿主DNS或防火墙。预期CNAME与TCP回退的域名HTTPS成功，Host／SNI仍是原valid域；循环／截断／不符合固定IP策略的AAAA结果失败且没有HTTP；TCP挂起手动取消一秒内、总时限约6000ms，单终态、资源归零且对端实际观察关闭。协议组只读账本，会准备公开虚构凭据。控制器finally删除自己的UDP／TCP规则、转发并强停本包；TCP对端允许TIME_WAIT后重启但拒绝已有监听器。

代理拒绝与恢复单列执行：

```sh
python3 scripts/run-android-connect.py --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5560 --expect-avd travelflow_p0_connect24 --expect-sdk 24 --port 19239 --client okhttp --case proxy
```

API35替换为5558／travelflow_p0_connect35／35／19238。工具只在指定私有AVD临时配置127.0.0.1:18510；已有代理或PAC时拒绝，不替换配置。预期PROXY_UNVERIFIED、无HTTP、无账本变化，随后精确恢复五个代理设置并冷启动正常HTTP；两段都通过才记通过。Android会将http_proxy旧键转换为global_*，仅删原键不足以清除代理；工具先设置系统认可的空代理，再恢复原值和原来不存在的键，支持空字符串参数。此项证明明确拒绝与测试恢复，不是代理转发支持，不可用于真机。

主机12组由CI的可选配置实际运行；三组CI仍只做构建／lint／打包和主机检查，不运行模拟器或root。当前实际Android证据与账本计数见PROJECT_STATUS；手机未安装这个实验配置。

## 下一项调查入口与跨仓协作

本仓库下一项由[移动路线P0](PRODUCT_ROADMAP.md)安排。已核对`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/CapacitorHttp.java`及同目录下的`util/HttpRequestHandler.java`：8.6.0实现读取完整响应后才resolve，公开请求接口没有单请求取消；销毁插件时的disconnect不等于用户可取消请求。原生适配探针已有上面的分块／取消／读取与TLS连接超时／总时限／显式恢复、HTTPS与虚构凭据验收入口，实际证据见PROJECT_STATUS；这只证明此环境中自建适配可行，不正式选定框架。框架与兼容性评审已形成，见ANDROID_FRAMEWORK_REVIEW；旧系统＋可更新WebView已补API24／26的32／64位匹配组合；连接故障实验已补SYN正例与DNS取消／硬时限失败；可选客户端已补平台及MiniDNS报文层的取消／TLS组合、当前网络绑定与代理拒绝／恢复；下一项补网络丢失／切换、缓存／搜索域／服务器失败预算和代理／Private DNS兼容方案，收口正式凭据生命周期及框架／支持范围提案。真实凭据／供应商仍未覆盖。参考[官方HTTP接口](https://capacitorjs.com/docs/apis/http)与[Android连接说明](https://developer.android.com/reference/java/net/HttpURLConnection)，仍以固定依赖源码和实际运行结果为准。

电脑端由另一会话负责。完整业务清单与保护约束见[接口能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CAPABILITIES.md)、[跨端总计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CONTINUITY_PLAN.md)。本地读写离线完整、联网后手机独立调用在线服务、双方在线直接同步已确定；无常驻应用服务器，本里程碑不加入云存储，第三方账号／中继与具体连接工具尚未批准。不能按个人机型缩窄开源兼容范围，也不因旅中优先删减规划／高级工程／回顾。

移动侧可自主验证平台适配；需要改变数据含义、共享契约或电脑配合时，先形成带版本的规格差异、需要电脑侧提供的接口和联合验收条件，交用户协调两会话，不能直接改电脑仓库或默认其会立即升级。契约仅导入已审阅的固定提交，升级后分别记录两端支持版本；不要把凭据加入业务同步或公开调试日志。设计快照、API矩阵是参考资料，不是移动功能已获用户验收的证明。
