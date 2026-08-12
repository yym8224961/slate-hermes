---
name: slate-device
description: 配置、诊断并正确使用 Slate 墨水屏渠道
---

# Slate Device

在配置、诊断 Slate，或需要判断墨水屏能力边界时使用本 Skill。日常对话的简短回复规范已由平台提示自动注入，无需每轮加载。

## 架构

```text
ESP32-S3 → Slate 后端（语音识别与请求队列）→ Slate 平台插件
          → Hermes Gateway → Agent → 插件回传 → 后端语音合成与设备播放
```

Slate 是 Hermes Gateway 的消息平台，与 Telegram 等渠道平级。平台插件负责通信；本 Skill 只提供设备知识与操作流程，不替代适配器。

## 配置

Hermes Gateway 需要：

- `SLATE_BACKEND`：Gateway 能访问的 Slate 后端根地址。
- `SLATE_AGENT_TOKEN`：访问后端 Agent 接口的 Bearer token。
- `SLATE_POLL_TIMEOUT_SECONDS`：可选，长轮询秒数，范围 1–60，默认 30。
- STT 语言在 Hermes 全局及当前 provider 配置中设定；Slate 插件不修改进程级语言环境变量。

Slate 后端需要：

- `HERMES_AGENT_TOKEN`：必须与 `SLATE_AGENT_TOKEN` 完全一致，生产环境至少 32 个字符。

密钥必须保存在持久环境配置或秘密管理器中。不得写入仓库、聊天回复或完整日志。

## 能力与限制

- 屏幕为 400×300 黑白电子墨水屏。
- 支持显示 Hermes 返回的语音转写文字和回复文字，并播放后端生成的语音。
- 当前交互由设备发起：用户录音或输入后，插件轮询请求并回传回复。
- 当前适配器不支持无关联请求 ID 的主动推送；不要声称提醒或 cron 已能直接投递到 Slate。
- 单次回复最多 512 个字符；实际对话通常应控制在 200 个汉字以内。

## 回复规范

- 默认使用简体中文，先说结论。
- 使用适合朗读的自然短句和纯文本。
- 避免表格、复杂列表、长链接、颜色指代和依赖版式的内容。
- 复杂任务先给摘要，再询问是否继续展开。
- 不修改 `SOUL.md`；设备约束属于平台提示和本 Skill。

## 诊断顺序

1. 用 `hermes plugins list` 确认 `platforms/slate` 已发现并启用。
2. 检查 Gateway 进程实际读取的三个 `SLATE_*` 环境变量，输出时遮蔽 token。
3. 确认 `SLATE_BACKEND` 从 Gateway 所在主机或容器可达；容器内的 `127.0.0.1` 只指向容器自身。
4. 检查日志是否出现 `[slate] Connected`、`Dispatching request`、401/403 或插件加载错误。
5. 401/403 表示两端 token 不一致；连接超时通常表示地址、DNS、防火墙或容器网络问题。
6. 从设备发起一条短语音，验证转写文字、请求入队、Hermes 回复、语音合成和设备播放完整链路；设备用户气泡应显示转写正文，而不是“（语音消息）”。

修改配置前先备份；不要覆盖已有 Hermes 人格、记忆或无关 Gateway 配置。
