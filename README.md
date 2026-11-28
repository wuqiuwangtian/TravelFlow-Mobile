# TravelFlow Mobile

[![CI](https://github.com/wuqiuwangtian/TravelFlow-Mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/wuqiuwangtian/TravelFlow-Mobile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TravelFlow 的独立移动端项目，面向 Android：目标是旅途中本地读写完整可用，联网后独立调用 AI／地图／检索，与电脑同时在线时直接同步。电脑端在 [TravelFlow-AI](https://github.com/wuqiuwangtian/TravelFlow-AI) 开发；不需要常驻服务器，本里程碑不加入云存储。

**目前仍是技术原型，不能用于真实旅行记账。** 已确认以Capacitor8.6.0为移动端实现起点，进入业务契约与本地存储设计；首次连接时，把 Windows 管理页的配对资料粘贴到手机，核对旅行和两端短码；再将手机显示的本机业务来源 ID 填入管理页授权。之后即可在这趟旅行的记账页离线保存消费。与已授权电脑恢复连接或重新打开应用后，手机会在前台自动投递，领取并确认电脑的金额更正。账本区分本机保存、待同步和对端确认，发生冲突或授权被撤销时会保留记录并暂停自动同步。同一旅行可先离线连记两笔，联网后按顺序确认；也可在首笔确认后继续记账。正式安装包、完整旅行同步和最低 Android 版本仍待确定。现有电脑网页的手机浏览器访问仍保留在电脑仓库。

原型已在Android 11／15搭配WebView124的隔离模拟器验证，旧内核不足时会明确提示；具体存储、网络、构建证据及未验证项见[项目现状](docs/internal/PROJECT_STATUS.md)。这不是正式最低版本或支持承诺。正式产品不要求用户启动终端；开发原型的准备和验收方式见[开发维护入口](docs/internal/MAINTAINING.md)。

源码采用 [MIT License](LICENSE)，依赖与移入素材见[第三方及来源说明](THIRD_PARTY_NOTICES.md)。
