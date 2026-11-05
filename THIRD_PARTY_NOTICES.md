# 第三方与迁移来源

本项目MIT许可，作者及许可文本见LICENSE。初始P0源码来自TravelFlow-AI提交 `974743fc9df181f01919d06e4cf3cc4a5908bd49`；源Git历史继续保留，不把文件迁移描述成重新实现。

- Capacitor core／android／cli 8.6.0：MIT，隔离候选锁文件位于prototypes/android-runtime/pnpm-lock.yaml。生成器将core许可复制进静态资源，第三方许可不因本项目MIT而改变。
- TypeScript 5.9.3：Apache-2.0，开发依赖，根目录pnpm-lock.yaml固定版本。
- vendor/design是原项目共享样式的MIT快照；精确提交与文件摘要见该目录ORIGIN.json，不能宣称与上游实时同步。
- vendor/contracts是实验账目投影契约快照；来源、固定提交与manifest摘要见vendor/contracts/ORIGIN.json。
- Android SDK、系统镜像、Gradle、JDK不在本仓库分发，各自许可由安装者遵守；生成的Android依赖以其包内许可为准。尚未发布安装包。
