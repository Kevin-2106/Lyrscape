# 实施路线

状态：计划，尚未完成各阶段。日期：2026-10-12。

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

SMTC adapter、歌词来源插件、用户预设、签名/更新/依赖回滚、可选插件目录。Windows 验收稳定后再评估其他平台的 overlay 与原生播放接入。

不提前承诺插件商店、所有播放器支持或跨平台 overlay 一致性。所有阶段都要区分“契约已写”“模拟验证通过”“真实播放器通过”和“原生桌面通过”。
