# 安全说明

当前是虚构数据技术原型，没有可供真实旅行使用的安全支持版本。不要提交密钥、个人记录、数据库、签名文件或包含这些内容的日志。

若发现泄密或可利用问题，请先通过[TravelFlow的私密报告渠道](https://github.com/wuqiuwangtian/TravelFlow-AI/security/advisories/new)报告，标明受影响的是TravelFlow-Mobile及具体提交，不要在公开Issue附上真实凭据。采用尽力维护方式，不承诺响应时限。

仅在自己的隔离模拟器测试。原型debug明文回显、固定token和SQLite单表不是正式网络鉴权或数据安全设计；真实凭据、日志脱敏、证书错误和备份迁移仍需后续验证。
