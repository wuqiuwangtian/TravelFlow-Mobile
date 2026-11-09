# 移动端任务路线

跨端里程碑权威计划仍见[电脑仓库专项计划](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CONTINUITY_PLAN.md)，本页只安排移动侧工作。仓库拆分不代表框架定型或P0结束；当前事实见[PROJECT_STATUS](PROJECT_STATUS.md)。

1. **P0进行中：独立工程和网络适配。** [框架与兼容性评审](ANDROID_FRAMEWORK_REVIEW.md)已形成评审稿；用户确认优先旧Android＋可更新WebView，旧内核继续评估，未选定正式框架／最低版本。API30／35＋WebView124的受控存储、流式、HTTPS、虚构Keystore、TLS连接取消／超时和总时限证据见PROJECT_STATUS；API30旧83明确提示能力不足且不改原数据，API26/default提供方环境阻塞；Google API24／26已运行Chrome69启动保护，官方API33新版组件因minSdk29被排除。下一项确定可核验的旧系统新版组件来源，补合法且提供方匹配的API24／26组合，再完善中间／较新系统与ABI矩阵；不能将环境故障当应用不兼容，也不将源码／功能检测当真机通过。TCP／DNS取消、真实供应商、正式凭据策略仍有缺口。按评审证据交用户确认框架与拟支持范围后再进入后续阶段；不缩窄开源目标，不把实验适配升格为正式产品接口。
2. **P1未开始：完整业务契约与可靠本地存储。** 与电脑端共同明确消费写入、日期、版本、设备身份、幂等、删除、冲突和附件；不能只靠当前汇总样例。覆盖全部现有目标能力，清单参考[电脑仓库接口能力矩阵](https://github.com/wuqiuwangtian/TravelFlow-AI/blob/main/docs/internal/MOBILE_CAPABILITIES.md)，不擅自删掉高级工程、规划或回顾。
3. **P2／P3未开始：独立移动业务与安全直连。** 与电脑端分别交付，按约定协议验证离线写入、在线独立服务、配对、增量、重传与并发冲突；无常驻服务器、不加入云存储。不能直接同步活跃SQLite文件，也不默认同步密钥。
4. **P4／P5未开始：手机体验与集成验收。** 用户评审交互，覆盖真机权限／省电／升级和完整电脑规划→手机使用→直连→电脑复核。性能调查按用户要求暂缓。最终验收不能仅靠模拟器或构建通过。
