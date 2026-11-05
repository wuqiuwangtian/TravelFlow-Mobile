# TravelFlow Mobile

[![CI](https://github.com/wuqiuwangtian/TravelFlow-Mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/wuqiuwangtian/TravelFlow-Mobile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TravelFlow 的独立移动端项目，面向 Android：目标是旅途中本地读写完整可用，联网后独立调用 AI／地图／检索，与电脑同时在线时直接同步。电脑端在 [TravelFlow-AI](https://github.com/wuqiuwangtian/TravelFlow-AI) 开发；不需要常驻服务器，本里程碑不加入云存储。

**目前仍是P0技术原型，不能用于真实旅行记账。** 当前只有虚构固定金额记录与HTTP回显测试，尚无正式安装包、完整业务、双端同步或确定的最低Android版本。Capacitor仅为候选，框架尚未正式定型。现有电脑网页的手机浏览器访问仍保留在电脑仓库。

原型已在Android 15模拟器验证离线读写与强停恢复；迁移后构建证据及未验证项见[项目现状](docs/internal/PROJECT_STATUS.md)。正式产品不要求用户启动终端；开发原型的准备和验收方式见[开发维护入口](docs/internal/MAINTAINING.md)。

源码采用 [MIT License](LICENSE)，依赖与移入素材见[第三方及来源说明](THIRD_PARTY_NOTICES.md)。
