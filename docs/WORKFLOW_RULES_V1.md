# 掌心窗 Workflow / Rules v1

这是一层**事件驱动**的规则引擎，不是定时任务系统。

核心模型：

`事件 -> 条件 -> 冷却/幂等 -> 动作 -> 运行日志 / Sol 收件箱`

## 第一批内置规则

### 1. 七秒猫出门检查

事件：`chat.intent.leave_for_study`

默认动作：
- 手机通知：`手机、钥匙、水、线——用手摸一遍再走`
- 在 Workflow Inbox 写一条 `departure_check`

10 分钟冷却，避免一句话重复触发很多次。

### 2. 日记页边纸条

事件：`diary.annotation.created`

默认动作：
- 写入 `reply_to_diary_annotation` 收件箱任务
- 保存 `entry_id / annotation_id / book_id`

模型/陪伴者处理完后用 `ack_workflow_inbox` 标记 `done`。

> 当前 v1 的规则引擎与 MCP 接口已经支持这个事件；如果纸条是手机前端本地直接创建，还需要 Android 端在创建成功后向 `/api/workflows/emit` 投递一次 `diary.annotation.created`。这属于下一层“原生事件源”接线，不需要改规则引擎。

### 3. 刷手机软刹车

事件：`app.overuse.detected`

条件：`payload.minutes >= 20`

默认动作：
- 先发一条自然提醒
- 写一条 `companion_decision` 到 Sol 收件箱

**不会默认自动锁 App。** 是否进一步进入屏幕休息交给 Sol 根据聊天与手机状态判断。

## 安全模型

后台规则可无新确认执行的手机动作仅：

- `send_notification`
- `set_alarm`
- `noop`

以下动作虽然规则引擎支持，但事件必须带 `payload.explicit_consent=true`：

- `screen_break_app`
- `end_screen_break`
- `extend_screen_break`
- `start_focus_mode`
- `end_focus_mode`
- `set_focus_plan`
- `trigger_guidian`
- `open_app`
- `screen_off`

这样一条配置错误的后台规则不会突然锁住手机。

## Server API

- `GET /api/workflows`
- `GET /api/workflows/runs`
- `GET /api/workflows/inbox`
- `POST /api/workflows/upsert`
- `POST /api/workflows/enable`
- `POST /api/workflows/emit`
- `POST /api/workflows/inbox/ack`

均沿用 `X-Auth-Token`。

### 事件例子

```json
{
  "event_name": "chat.intent.leave_for_study",
  "payload": {
    "destination": "library"
  },
  "source": "mcp"
}
```

```json
{
  "event_name": "app.overuse.detected",
  "payload": {
    "app_name": "小红书",
    "package": "com.xingin.xhs",
    "minutes": 37
  },
  "source": "phone"
}
```

高影响动作的显式授权事件：

```json
{
  "event_name": "chat.intent.focus_requested",
  "payload": {
    "explicit_consent": true,
    "duration_minutes": 45
  }
}
```

## MCP 工具

补丁增加：

- `list_workflows`
- `get_workflow_runs`
- `get_workflow_inbox`
- `emit_workflow_event`
- `upsert_workflow`
- `set_workflow_enabled`
- `ack_workflow_inbox`

其中 `emit_workflow_event` 是聊天语义和规则引擎之间的桥。例如用户说“我要去图书馆”，Sol 不需要设置任何 schedule，只要投递一次 `chat.intent.leave_for_study`。

## 数据文件

默认位于 server 的 `LINJIAN_DATA_DIR`：

- `workflows.json`
- `workflow_runs.json`
- `workflow_inbox.json`

规则、运行历史、待 Sol 判断事件彼此分离。

## 与现有 activity events 的关系

- 手机状态更新会产生内部事件 `device.state.updated`
- 手机命令回报会产生 `command.completed`
- `/api/activity/events` 接收到新事件时会同时发出 `activity.created`
- Workflow 自己产生的 activity event 不会再次触发 `activity.created`，防止循环

## 下一步最值得接的原生事件源

1. Android 日记：新增页边批注后 -> `diary.annotation.created`
2. Android 使用统计：小红书/抖音连续前台达到阈值 -> `app.overuse.detected`
3. Focus：结束/求助/应急放行 -> 语义事件
4. 归电：接受/拒绝 -> 语义事件
5. Solune watcher：直接消费 `/api/workflows/inbox`，把需要模型判断的任务推给 Sol，而不是定时扫
