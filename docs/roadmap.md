# 实施路线

状态：目标路线。2026-10-13 的基础文字与只读 AMLL 接入版本已实现，详见 [第一版说明](baseline.md)。M0 的完整 manifest/权限隔离与 M3 的第三方包生态仍未完成。原计划日期：2026-10-12。

2026-10-13 补充：内置插件管理 / 配置 UI、分类、可选启停与 Aurora 独立动画 renderer 已实现；普通文字仍为默认。已实现 renderer 选择与 scope 释放，但这不代表 M3 的第三方包、隔离和通用 effect 插槽完成，详见 [插件说明](plugins.md)。

同日新增三个独立 PV renderer（糖果波普 / 情书 / 水底挽歌，canvas 实现），还原参考 PV 的字体、配色与特效，独立配置并共享时间采样。仍属于可信内置源码组合，不代表完整 PV 场景编辑器或第三方包生态，见 [实现说明](pv-renderers.md)。

## M0：宿主与 SDK

实现 manifest/schema、service registry、插件 scope、依赖解析、版本匹配、权限代理和恢复入口。提供 mock playback adapter，正式定义会话/曲目/歌词/时间契约。

验收：两个独立 adapter 可切换；缺依赖/循环依赖可诊断；激活失败能回滚；卸载撤销资源和写入 lease；任意第三方 ID 不能伪装内置插件取得额外权限。

## M1：可运行的最小插件组合

Tauri Windows 宿主 + mock adapter + 默认 timeline + LRC parser + 基础 renderer + overlay surface + 设置插件。

验收：逐行、逐字和静态文本可显示；透明置顶、穿透/编辑模式切换、多屏/缩放/休眠恢复实机验证；各视图使用同一 timeline。具体组合需要验证是否出现黑底、白闪、焦点抢占或全屏遮挡问题。

## M2：AMLL adapter

实现本地原生 WebSocket broker 与 AMLL adapter。选择并记录 codec 来源/许可，按目标发送端优先级支持 V1/V2，加入 TTML parser。

验收：至少一个真实生态发送端完成曲目/歌词/暂停/seek/重连验证；报告采样间隔与实际误差；多个连接不互相覆盖，控制定向到会话；未知播放状态不盲目外推。

## M3：证明 All is plugin

第三方示例替换默认 renderer、timeline、theme 和一个视觉 effect；在不修改 kernel 的情况下切换 adapter 驱动相同 overlay。建立可独立导入的插件包与开发重载流程。

验收：自定义布局/Canvas 或 WebGL 效果正常运行；不兼容扩展槽可诊断；故障插件可禁用恢复；逻辑阻塞和视觉资源过载的隔离边界通过实测记录。私有全局变量或默认 renderer DOM 不得成为插件 API。

## M4：更多接入与分发

歌词来源插件（SMTC adapter 与 LRCLIB / 网易云在线歌词已于 2026-10-18 实现）、用户预设、签名/更新/依赖回滚、可选插件目录。Windows 验收稳定后再评估其他平台的 overlay 与原生播放接入。

不提前承诺插件商店、所有播放器支持或跨平台 overlay 一致性。所有阶段都要区分“契约已写”“模拟验证通过”“真实播放器通过”和“原生桌面通过”。
