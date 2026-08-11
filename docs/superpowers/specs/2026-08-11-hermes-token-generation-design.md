# Hermes Token 生成与持久化设计

## 目标

登录 Slate Web 后，用户可以生成一个新的共享 Token，复制给 Hermes Gateway 一次；Slate 容器自动持久使用同一个 Token。刷新页面、重启 Slate 容器或重新部署镜像后，Token 仍然有效，不要求给 Web 应用挂载宿主机 Docker socket，也不把现有共享 Token 返回给浏览器。

## 非目标

- 不让 Web 应用直接修改宿主机 Compose 文件或 `docker inspect` 中的环境变量。
- 不返回当前 Token 的查询接口。
- 不把 Token 放进 `localStorage`、URL、日志、连接状态接口或错误响应。
- 不改变 Hermes Gateway 插件的 Bearer Token 协议。

## 方案

前端使用 Web Crypto API 生成 32 字节随机值，并编码成 64 个十六进制字符。用户点击生成后，前端在登录态下调用 `POST /api/v1/hermes/token`，后端校验 Token 格式并原子写入 `dirname(BLOB_DIR)/hermes-agent-token`。生产 Compose 中 `BLOB_DIR=/data/blobs`，因此实际文件为 `/data/hermes-agent-token`，位于现有 `/data` 持久卷内。

后端启动时由 `HermesTokenStore` 读取持久文件：

1. 文件存在时，使用文件中的 Token，覆盖环境变量作为 Hermes Agent 鉴权值。
2. 文件不存在时，兼容现有 `HERMES_AGENT_TOKEN` 环境变量。
3. 文件存在但不可读或格式非法时启动失败，避免静默降级成错误 Token。

写入使用同目录随机临时文件、`0600` 权限和 `rename` 原子替换；内存中的鉴权值在写入成功后立即更新，因此无需重启容器。Agent guard 和连接状态都读取同一 `HermesTokenStore`，不会出现“状态显示已启用但长轮询仍用旧 Token”的分叉。

## API

### `POST /api/v1/hermes/token`

- 需要现有 JWT 登录态。
- 请求体：`{"token":"<32–256 个安全字符>"}`。
- 允许字符：ASCII 字母、数字、`.`、`_`、`-`、`~`，拒绝空白和控制字符。
- 成功响应只返回 `{ "configured": true }`，不回显 Token。
- 错误响应不包含请求体或 Token 内容。

现有 `GET /api/v1/hermes/status` 继续只返回 `enabled`、`connected` 和 `last_seen_at`。Agent 的 Bearer 鉴权会读取持久化 Token；原有环境变量回退保持兼容。

## 前端交互

Hermes 接入区新增“生成共享 Token”面板：

- 点击后生成 Token、保存到后端，并在当前页面显示完整值。
- 提供复制 Token 和复制 Hermes 配置两个动作。
- 配置复制内容包含当前 `SLATE_BACKEND`、`SLATE_AGENT_TOKEN`，以及已经保存的 Token。
- Token 只保存在 React 内存状态；刷新或离开页面后不再显示，用户可以重新生成并替换。
- 保存失败时不显示“已配置”，并保留重试入口。
- 原有“配置模板”在未生成 Token 时继续显示占位符；生成后自动填充已保存的值。

## 安全与运维边界

- 生成接口和状态接口都受 Web JWT 保护；只有登录用户可以替换 Token。
- Token 永不写入前端持久存储、服务日志、请求日志字段或状态响应。
- `/data` 已是 Slate 的现有持久挂载，Compose 升级不触碰该目录。
- 回滚到旧镜像时，旧代码仍可使用环境变量；持久 Token 文件不会被删除。
- Token 替换后旧 Hermes Gateway 会立即收到 401，需要用户把新 Token 更新到 Gateway 并重启 Gateway。

## 验证

- 后端单测：Token 格式校验、原子写入/重载、环境变量回退、文件损坏失败、Agent guard 使用最新值。
- 前端生产构建、lint、TypeScript 检查；生成值长度、字符集和复制配置内容的单测或纯函数测试。
- 集成验证：未登录调用生成接口返回 401；登录后生成接口只返回 `configured`；带新 Token 的 Agent 长轮询成功，旧 Token 失败；状态接口不返回 Token。
- NAS 回读：新 Slate 容器使用新镜像 revision，`/data` 挂载、网络、端口、MySQL 容器和重启策略保持不变，`/healthz` 成功。
