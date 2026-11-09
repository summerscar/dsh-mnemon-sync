# dsh-plugin-index 收录申请（复制到 issue 模板）

## 插件地址

@summerscar/dsh-mnemon-sync
（源码：https://github.com/summerscar/dsh-mnemon-sync）

## 简短说明

为 dsh-mnemon 的记忆做备份与恢复：三类记忆组件（记忆空间、项目档案、运行时记忆）可任选，打包到 S3 兼容存储或 WebDAV，支持定时备份、备份列表查看与选择性恢复。数据库经 node:sqlite 的 backup() 在线复制，每个文件带 SHA-256 校验，恢复默认预览、确认后才写盘。备份文件名带设备名，多机备份可区分。零外部依赖，MIT 许可。

## 补充信息

- 已测试 DSH 版本：0.2.2-rc.1（声明范围 >=0.2.1-rc.1 <0.3.0-0）
- 平台：Linux x64（Web profile）
- npm：https://www.npmjs.com/package/@summerscar/dsh-mnemon-sync（latest 0.1.6，本地 0.1.7 待发）
- 许可证：MIT（package.json license 字段 + 仓库 LICENSE 文件）
- dsh.bundle.patch 已声明，补丁与全部入口文件均在发布包内
- HTTP 接口已接入宿主认证（connection.requestRejection）
- 仓库 topics：dsh-plugin / deepseek-harness / dsh-mnemon / mnemon / backup / restore / webdav / s3 等
