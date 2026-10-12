# AMLL adapter 调研与设计

核查日期：2026-10-12。状态：代码与协议阅读完成，尚未实现 adapter 或连接真实播放器。

## 已核查的上游

- [AMLL WS Protocol](https://github.com/amll-dev/ws-protocol/tree/b85b04b7da6992544ac813a26a5778be674b62b5)，核查 commit：`b85b04b7da6992544ac813a26a5778be674b62b5`。
- [V1 规范](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL.md)、[V2 规范](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL_V2.md)、[V1 实现](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/src/v1.rs)、[V2 实现](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/src/v2.rs)。
- [AMLL Player 接收服务](https://github.com/amll-dev/amll-player/blob/90c1b909b7a6b0ca7b7f468c343868fbfd026883/packages/player/src-tauri/src/server.rs)，核查 commit：`90c1b909b7a6b0ca7b7f468c343868fbfd026883`。

## 关键结论

1. V1 是二进制协议；V2 以 JSON 传输状态和指令，并单独提供 PCM/封面的二进制通道。上游推荐 V2，但现有发送端的版本必须实测。
2. 当前 AMLL Player 接收服务在原生层监听 WebSocket：首个文本消息须为 initialize 才选择 V2，首个二进制消息选择 V1。普通浏览器 WebSocket 只能主动连接，不能替代本地监听服务。
3. 进度是毫秒值。V1 文档明确不限制报告间隔，并要求接收端补偿；V2 Progress 只有进度值，不携带发送时间戳、序号或速率字段。因此协议可以传达直接播放位置，但无法单凭规范保证固定精度或识别单向传输延迟。
4. 同一连接内 WebSocket 保持消息顺序，但不能替代跨重连、切歌、异步歌词任务的会话修订管理。

## Lyrscape 的适配边界

默认角色为原生 broker 监听本机回环地址，由播放器端连接；端口可配置，遇到占用给出明确错误。adapter 是协议解释与数据映射插件，socket 创建/监听/关闭由 broker 执行。未来主动连接模式可以作为 adapter 配置增加，不要求修改 renderer。

版本在连接建立时确定并锁定。V1 和 V2 的二进制 magic 值含义有重叠，不能逐帧猜版本。V2 initialize 与 V1 首帧行为参考上游，但兼容性须对接目标发送端后验证。重连请求当前状态，状态不完整时保持 unknown/connecting，不用旧歌曲内容冒充新会话。

| 上游信息 | Lyrscape 输出 |
| --- | --- |
| 曲目元数据 | 会话 scoped Track、递增的 trackRevision |
| Progress / OnPlayProgress | PlaybackSample，记录宿主收到消息的单调时间 |
| 暂停 / 恢复 | 明确的播放状态更新 |
| 结构化歌词 | 统一 LyricDocument，保留逐字/翻译/音译/声部信息 |
| TTML 字符串 | 交给已注册的 TTML parser，携带会话和曲目修订 |
| 封面 / PCM | 有限大小的资源引用或独立音频流 |
| 控制指令 | 动态能力许可后定向发送到该会话连接 |

AMLL wire 消息不传播给视觉插件。缺少速率时可按策略采用 1 倍速估计，并标明估计；缺少播放状态时保留未知。音频数据不含足够的格式描述时，不能任意解释成固定采样格式。

控制不能广播给所有播放器。AMLL 规范定义了一项指令，不表示每个发送端都实现它；adapter 从已验证的发送端配置或能力确认中开放控制，默认可以只读。

## 同步设计

接收端将进度作为首选位置来源。timeline 插件从锚点逐帧采样，暂停停止推进、seek 立即重置、断线限时停止外推；保留用户/设备偏移。小幅漂移平滑策略可替换。

没有发送时间戳时，以接收时刻锚定存在传输偏移。Ping/Pong 可用于存活或 RTT 诊断，不能在没有额外约定时声称准确测出单向延迟或直接减半 RTT 校准。验收报告必须写发送端、更新频率、负载、显示设备和测量方法。

## 连接边界

默认仅本机监听，LAN 接入作为显式配置。回环地址也不构成认证；对来自浏览器的 Origin 做限制，对不能携带凭据的旧发送端采用可见的连接确认/白名单兼容方式。认证方式需要保持与目标发送端兼容，不能宣称 AMLL 已内置认证。

broker 限制连接数、首帧等待、消息体/歌词/图片/PCM 大小和消息频率。封面 URL 不自动赋予任意网络或本地文件权限；资源代理按允许来源获取并做图片解码预算。旧实例卸载必须关闭监听器和所有连接。上述控制目前都是设计要求，尚未实现。

## 依赖与许可待决项

核查快照中，仓库 LICENSE 为 AGPL v3，而 package.json/Cargo.toml 的 license 字段写 GPL-3.0；在引入官方 codec 前须确认选定发布产物的准确许可。兼容通信协议和复用上游实现是两项不同选择。本次未复制或引入上游代码，Lyrscape 许可证暂不指定。

## 首个联调清单

- 目标发送端名称/版本、V1/V2、连接角色与首帧；不只验证模拟消息。
- 切歌、暂停/恢复、seek、重连、发送端退出和多个会话选择。
- 逐字/逐行/无歌词、翻译/音译、背景声、缺字段和过大 payload。
- 从稀疏到高频进度更新的视觉误差、CPU/GPU 占用；不预先承诺精度数字。
- 卸载 adapter 后端口释放；旧回调不能污染新会话；播放指令仅发到选定连接。
