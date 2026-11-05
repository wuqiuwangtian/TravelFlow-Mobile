# 移动端项目现状

2026-11-05：从TravelFlow-AI迁出P0实验，源码来源974743f；契约来源见vendor/contracts/ORIGIN.json，设计来源见vendor/design/ORIGIN.json。框架仍是Capacitor候选，正式Android应用、完整账本和同步均未实现。版本0.0.0仅标识开发仓库，不是产品发布。

## 能力与证据

迁移前原型在WSL2/KVM的Android15（API35、default x86_64、WebView124.0.6367.219）验证：原生SQLite保存123分、同ID重放不增加；飞行模式下强停重开仍保留，可追加到246分；再次强停保持；原生HTTP虚构服务POST200，服务／网络失败后仍可追加至369分。只读导出的虚构SQLite副本核对3条／369分／3个唯一ID。历史证据归属桌面提交974743f，不能冒充迁移后重新跑过。

迁移后验证已完成：新仓库独立冻结安装、快照来源／摘要检查、14组账目对照、非法输入防护、TS类型检查、脚本语法与Python编译通过；篡改快照与浮动Git版本被拒绝，npm审计零已知漏洞。独立生成路径包含空格的工程，复用隔离SDK缓存离线执行`:app:assembleDebug`通过（JDK21、SDK36、Build Tools35.0.0）。新APK全部assets与迁移前逐字节一致，两个Java源码也保持一致；本轮未重新运行模拟器交互，不将历史运行证据写成重新验证。生成工程在`/tmp/travelflow mobile standalone p0/`，不进入Git。初始提交8443cd0的远端CI通过（含独立APK构建）。vendor快照固定LF，另在core.autocrlf=true的检出副本验证摘要保持；这不是Windows原生APK构建或真机验收。最新CI仍按提交核对，未正式发布。当前构建与检查入口见MAINTAINING，当前下一项见PRODUCT_ROADMAP。 SDK及生成工程均在仓库外；不读取个人旅行、配置或真实供应商。

## 未覆盖

没有真机、ARM64／最低版本矩阵、存储不足、升级迁移、安全凭据、HTTPS失败、SSE分块、真实取消与恢复证据；没有正式签名或发布。桌面端Windows／WSL启动和网络连接原型由原仓库负责，移动构建不导入桌面源码。跨端契约目前只有只读账目投影0.1.0，不是完整数据或同步契约。
