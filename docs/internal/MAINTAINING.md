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

生成目录必须不存在，脚本拒绝覆盖。Windows可使用自己的新目录路径；不依赖电脑仓库、Python业务或上游网络。首次安装依赖仍需网络，只有显式更新契约才需上游Git副本。生成器在目标目录按独立锁文件安装Capacitor候选，不安装SDK或接受许可。

Android构建需JDK21、SDK Platform36、Build Tools35.0.0；Gradle wrapper8.14.3、AGP8.13.0。为当前进程设置自己的JAVA_HOME／ANDROID_HOME／ANDROID_USER_HOME／GRADLE_USER_HOME，在生成工程android目录运行 `./gradlew :app:assembleDebug --no-daemon`，Windows用gradlew.bat。debug APK在 `app/build/outputs/apk/debug/app-debug.apk`。本机已授权用于隔离原型的SDK许可与下载，缓存沿用 `~/.cache/travelflow-p0-android/`；其他贡献者自行安装并接受许可。CI只构建候选APK，不发布或签署正式安装包。

## 原型交互验收

可选测试对端：`python scripts/android_probe_service.py`，仅监听127.0.0.1:18510，不读取.env，Python仅用于开发测试。只向自己的隔离模拟器安装org.travelflow.p0；打开后原生桥就绪，保存1.23元，重放同一操作条数／金额不增加；强停重开保持，关闭网络后冷启动可继续新增。恢复网络时测试POST通过；停止测试服务后网络失败，但本地继续保存。已有记录不会因重开归零，不能默认每次验收从空库开始。

服务无CORS；原生HTTP访问10.0.2.2的宿主回显服务，虚构token非真实鉴权。仅debug为该地址允许明文，release默认拒绝；此地址不适用真机。未调用真实模型／地图，流式／取消仍待验证。浏览器无法提供原生插件能力；不可把桌面触屏模拟当Android验收。

## 契约与设计快照更新

权威数据契约在电脑仓库contracts，移动侧vendor/contracts保存固定版本。根目录执行 `node scripts/import-contract.mjs --source <电脑仓库Git副本> --commit <完整40位提交SHA>`，仅显式更新时需要此副本；导入前验证上游摘要，再运行三项检查、审阅差异并提交。当前导入器只支持实验ledger-v1，不是未来同步协议协商工具。既有契约版本不可原地改写；新规则需先由两端评审版本与迁移。

vendor/design为固定提交样式快照，更新时逐文件对照上游，更新ORIGIN摘要并审阅主题／按钮状态；不能把复制等同实时共享。src/domain/ledger.ts由移动端维护，受共享样例约束，不会自动跟随桌面Python实现。
