# PCM 音频接入与全局快捷键

2026-10-13。AMLL PCM 与全局快捷键已实现；指定程序音频捕捉仍为后续可选来源。

## 结论与实施顺序

优先复用播放器提供的 PCM。Lyrscape 保留收到的采样字节，由需要音频的插件自行选择 FFT、音量、节拍或波形算法。接入音频不要求启用某个歌词 renderer，普通歌词也不要求收到音频。

指定程序捕捉适合成为可选音频 provider：AMLL/其他 adapter 没有提供 PCM 时，用户显式选择目标程序。消费者依赖统一的 `audio.pcm@1` 服务，不绑定具体捕捉插件。以后可以另加频谱服务，支持格式明确的现成 FFT；不把 FFT 当作唯一音频输入，也不把频谱数组塞进 AMLL 的 PCM 字段。

本轮没有启动 WASAPI 捕捉或修改正在运行的原 Lyrscape 实例。捕捉目标选择、系统版本检测和音频 provider 切换界面尚未实现。

## AMLL 核查

通过 GitHub API 核查 main 指向的提交，并只读查看对应源码：

| 仓库 | 核查提交 | 结论 |
| --- | --- | --- |
| ws-protocol | `b85b04b7da6992544ac813a26a5778be674b62b5` | V1/V2 有 PCM，未定义 FFT 消息 |
| amll-player | `90c1b909b7a6b0ca7b7f468c343868fbfd026883` | WS 接收 PCM 后在客户端计算 FFT |
| fft | `6cb0670daa638898937751029fc4d96930112aff` | `FFTPlayer` 接收多种 PCM 类型并生成频谱 |
| applemusic-like-lyrics | `86200dead453bb067e554e989110cbadca8d4756` | React Full 组件可直接消费现成频谱 |
| amll-bncm-ws-connector | `b5ca43a5806ea28672731851ab2c9352e8170c43` | 网易云 3.x 路径能取得 PCM，WS wrapper 发送 PCM |

- [V1 规范](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL.md)：`OnAudioData` 的 magic 为 9，指定 48,000 Hz、双声道、i16、交错 PCM。整个协议为小端编码。
- [V2 规范](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL_V2.md)及[类型实现](https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/src/v2.rs)：支持 JSON `state.audioData` 和二进制 `OnAudioData`（magic 0）；音频负载没有采样率、声道数、采样格式或采样时间戳字段。
- [Player WS 接收路径](https://github.com/amll-dev/amll-player/blob/90c1b909b7a6b0ca7b7f468c343868fbfd026883/packages/player/src/components/WSProtocolMusicContext/index.tsx)：把字节解释成 i16，以 `pushDataI16(48000, 2, ...)` 输入 FFT，然后读取 64 个频谱值。这里是接收外部 PCM，并非按 PID 捕捉其他程序。
- [Connector WS wrapper](https://github.com/Steve-xmh/amll-bncm-ws-connector/blob/b5ca43a5806ea28672731851ab2c9352e8170c43/src/music-context/ws-wrapper.tsx)：连接激活时 acquire 音频，并将 `audio-data` 作为 `onAudioData` 发出。[网易云 3.x 实现](https://github.com/Steve-xmh/amll-bncm-ws-connector/blob/b5ca43a5806ea28672731851ab2c9352e8170c43/src/music-context/v3.ts)调用 `audioplayer.enableAudioData`，处理原生 `AudioData` 回调；同时在内部生成 `fft-data`，WS wrapper 发送的仍是 PCM。[基类](https://github.com/Steve-xmh/amll-bncm-ws-connector/blob/b5ca43a5806ea28672731851ab2c9352e8170c43/src/music-context/index.ts)的 acquire 默认为空，不能由 3.x 实现推断全部版本支持音频。本轮没有验证用户已安装 Connector 的版本与实际 PCM 发送情况。
- [FFT 模块](https://github.com/amll-dev/fft/blob/6cb0670daa638898937751029fc4d96930112aff/src/fft_player.rs)：提供 PCM push/read，内部包含混声道、重采样、加窗和频谱处理。它适合可视化分析，但经过处理的输出不能代替原始 PCM。
- [频谱组件](https://github.com/amll-dev/applemusic-like-lyrics/blob/86200dead453bb067e554e989110cbadca8d4756/packages/react-full/src/components/AudioFFTVisualizer/index.tsx)支持 `fftData: number[]`；[状态入口](https://github.com/amll-dev/applemusic-like-lyrics/blob/86200dead453bb067e554e989110cbadca8d4756/packages/react-full/src/states/dataAtoms.ts)提供 `fftDataAtom`。因此“组件能接受现成 FFT”与“WS 协议传 FFT”是两件事。外部频谱还需说明频带和数值尺度；不能直接把 dB、0–255 或 0–1 的数组当作同一种数据。

Lyrscape 未复制或引入 AMLL codec/FFT 实现。未来若复用库，需要核查选定发布产物的许可；FFT 仓库 LICENSE 与包元数据存在 AGPL/GPL 标注差异，不能只据 package.json 决定。

## 已实现的 PCM 契约

`official.audio.pcm` 提供 `audio.pcm@1`，主窗口与 overlay 各有一个服务实例；`official.adapter.amll` 声明对它的依赖。服务在无音频时保持可用，`read()` 返回 undefined。

实现位置：`src/sdk/types.ts`、`src/plugins/audio.ts`、`src-tauri/src/audio.rs`，以及 AMLL decoder/broker。

```ts
const audio = ctx.service<PcmAudio>('audio.pcm@1');
const unsubscribe = audio.subscribe(frame => {
  if (!frame) {
    // 切歌、暂停、断线或换来源：清空自己的分析窗口。
    return;
  }
  // frame.data 是来源 PCM 的原始字节。需要原地修改时先复制。
  // 可在自己的 Worker/算法中分析；不要写回共享字节。
});
ctx.own(unsubscribe);
```

| 字段/行为 | 含义 |
| --- | --- |
| `data: Uint8Array` | 保留收到的采样字节，无混声道、重采样、增益或 FFT |
| `format` | 当前 AMLL 兼容格式为 48 kHz / 双声道 / i16le / interleaved |
| `format.basis` | V1 为规范指定；V2 为 AMLL Player 的兼容解释，非 V2 帧内声明 |
| `sourceId`, `revision` | 选定连接与流修订；切歌、暂停、断线和换来源清空旧块 |
| `sequence` | 宿主生成的音频块序号，不伪装成发送端提供的序号 |
| `receivedAtEpochMs` | 原生收到并处理该块的时间，不是采样时间或歌曲进度 |
| `receivedAtMonoMs` | 当前 WebView 收到该块的单调时间 |
| `droppedFrames` | 本订阅窗口积压时丢弃的音频块数；“frame”在该字段中指传输块 |
| `frameCount` | 当前块内的双声道采样帧数，即字节数 / 4 |
| `read(maxAgeMs = 500)` | 读取最后一个块；超龄返回 undefined，不保留历史录音 |

V1、V2 二进制与 V2 JSON 音频均支持。只转发当前歌词 adapter 选中的连接；切回 demo 后停止转发。只接收完整双声道 i16 采样帧，每块上限 64 KiB（约 341 ms），空块忽略，非字节/截断/超限音频拒绝。其他 PCM 格式以后应通过有格式描述的 provider 引入，不猜测字节格式。

音频使用独立 Tauri Channel，不进入 `AppState`、歌词广播或 localStorage。每个窗口最多有 4 个未确认 PCM 块；处理完成后确认，积压时丢弃后续块并在下一块报告丢弃数量。消费者只有一个最新块缓存，应消费 subscribe 获得的连续块；`read()` 适合实时视图采样，不保证包含每个块。

Channel 的 PCM 数据使用二进制 IPC：`LPCM` / version 1 的 40 字节小端头，随后是 UTF-8 来源 ID 与原始 PCM。头记录协议版本、来源 ID 字节数、revision、sequence、接收时间与 droppedFrames；reset 仍为同一 Channel 中的 JSON 消息以保留顺序。前端从 ArrayBuffer 建立 Uint8Array 视图，不再构造数字数组或复制一份采样字节。原生封包与 WebView2 传输仍有复制，不能称为端到端零复制。参见 [Tauri Channel 原始字节说明](https://v2.tauri.app/reference/javascript/api/namespacecore/)。

“原始”表示与 Connector 发出的 PCM 字节一致。若 Connector 已把源文件转换为 48 kHz/i16，Lyrscape 无法恢复更高采样率、位深或压缩音频原件。协议缺少采样 PTS/曲目关联，不能声称音频与歌词已达到采样级同步。

第一个消费者是 [节拍检测](beat-detection.md)（`audio.beat@1`）。

## 指定程序捕捉的后续设计

[Microsoft Application Loopback 示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)支持按 PID 包含目标进程及其子进程，最低要求 Windows build 20348。应检测平台能力；不能把普通输出设备 loopback 当成按程序隔离的替代实现。

建议插件 `official.audio.capture.windows`：用户从有音频活动的程序列表中选择目标，再启动捕捉。显示程序名和 PID，运行期间绑定进程实例；退出或重启后停止/重新确认，避免只存 PID 后误捕捉被复用的 PID。自动关联只能使用 adapter 提供的可核查身份，AMLL 的 localhost 连接本身不能证明哪个 PID 是实际播放进程。

多进程播放器可包含子进程；浏览器按进程捕捉未必能区分标签页。失败或没有音频时应显示 unavailable/silent，不自动扩大为整个系统混音。系统混音可以是另外一个用户明确选择的来源。

若捕捉 API 提供 Float32/其他采样率，保留该格式并扩展统一 PCM 契约，不为了迁就当前 AMLL profile 降为 i16/48 kHz。FFT/RMS 等始终由分析插件派生。

## 全局快捷键与调整边框

`official.shortcuts.global` 是可信内置插件，提供 `shortcuts.global@1`。原生层使用官方 `tauri-plugin-global-shortcut`，Windows 后端注册系统 hotkey；触发只处理 Pressed，平台实现禁止按住重复触发。

| 操作 | 默认组合 |
| --- | --- |
| 显示 / 隐藏桌面歌词 | Ctrl+Shift+L |
| 切换鼠标穿透 | Ctrl+Shift+P |
| 显示 / 隐藏调整边框 | Ctrl+Shift+B |

在「桌面歌词」页编辑并应用。可留空取消某一绑定，成功配置保存在 `lyrscape.shortcuts.v1`；重置全部设置也清除此项。「关于」页显示当前绑定和注册状态。

显示边框会标出透明窗口范围及左右拖拽把手，独立于穿透开关。开启穿透时边框仍可见，但调整位置/宽度需关闭穿透。边框只绘制在 overlay，不影响歌词内容高度。

冲突检测包含：规范化 Ctrl/Control、KeyL/L 和修饰键顺序；拒绝无修饰键、多个普通按键、应用内导航和部分常见系统组合；阻止三个动作绑定同一组合；尝试实际向操作系统注册以检测外部占用。官方 `isRegistered` [只查询本应用](https://v2.tauri.app/reference/javascript/global-shortcut/)，不能用于检测其他进程。

更换时先注册新组合，成功后释放旧组合。注册失败提示“可能被其他程序或系统占用”，保留旧绑定与保存值；启动时某个组合失败不阻止其余功能启动。无法枚举所有程序的自定义键盘钩子或指出占用者身份，不宣称检测到了全部语义冲突。

## 验证与运行

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:build
node scripts/smoke-browser.mjs
node scripts/smoke-plugins.mjs
$env:LYRSCAPE_CDP = 'http://127.0.0.1:9229'
$env:LYRSCAPE_TEST_PID = '<独立 QA exe 的 PID>'
node scripts/smoke-audio-shortcuts.mjs
node scripts/smoke-desktop.mjs
```

音频/快捷键 smoke 只用于独立 QA 实例，脚本会更改快捷键并使用 11445 fixture。`shortcut-fixture.ps1` 将 Ctrl+Alt+Shift+F20–F23 用于测试，另启进程占用 F23 验证真实冲突；最小化/恢复操作只允许操作仓库内指定的 QA exe。

最终构建已通过：53 项前端测试、12 项 Rust 测试（含 PCM V1/V2/JSON 字节一致、非法负载、背压与来源隔离），主窗口最小化后 Windows 实际按键触发全部三个动作，外部进程占用时原组合保留，设置保存/重载/取消，原生 Channel 字节传输、最多 4 块积压及丢块计数，换来源停止传输，浏览器与原生 V1/V2 歌词回归。Edge 插件管理回归也通过；原生设置与边框截图已查看，快捷键面板的内边距已修正。

交付 `builds/Lyrscape-audio-shortcuts.exe`，原 `builds/Lyrscape.exe` 保留。交付 exe 与 Rust release 产物的 SHA-256 均为 `7544AFE82EE303220FCE75A57EEB608F7D3EB4E9BB17657A9512AD77469DF7D4`。测试使用独立数据目录、CDP 9229 和 fixture 11445；未对原实例发送控制或配置命令。测试实例与本轮启动的 Vite 服务已关闭。

尚未验证：真实安装版本 Connector 的 PCM、连续长时间音频负载、按 PID 捕捉、音频效果算法和采样级视听同步。本轮没有启用这些能力。
