# 本机资源、文件与设备管理

本机资源面板位于中枢“系统”，指定工作目录整理位于“文件”，多设备汇总沿用远端陪伴页面。状态读取不启动绘图或歌声模型，关闭状态保留；实际用户生成请求仍使用原入口按需启动。

## 本地资源

重计算任务非抢占串行；语音和语义检索是高优先轻任务，后台索引优先级较低。资源预算是中枢任务的预约合计，不是整机的内存或显存硬上限；采集值与预约值分开。未配置模型占用估计时不猜数，默认只执行并发保护。启用数字预算需要同时配置每类任务的可靠估计，否则该任务会在执行前明确拒绝，不能偷偷跳过预算。

配置沿用runtime/config.json的localResources对象，支持limits.memoryBytes/gpuBytes正整数；voiceEstimate、drawingEstimate、singingEstimate使用estimatedMemoryBytes/estimatedGpuBytes字节数；semanticEstimates.embedding同样配置估计。限额与估计需根据本机实测填写，不提供伪造默认值。当前默认模型、质量和推理设置均不因调度改变。

sampleIntervalMs默认60000，范围30000—3600000。monitorSettings.timeoutMs默认2000（10—60000），sampleLimit默认1440（1—100000）。healthThresholds支持cpuPercent/memoryPercent/diskUsedPercent/gpuPercent百分比、consecutiveSamples连续次数、recoverySamples恢复次数、recoveryHysteresis百分点、cooldownMs冷却时间以及taskStallCount/taskStallAgeMs。未知配置或越界数值明确报错。

正常采样不发送消息，不调用模型；持续异常与恢复进入已有QQ去重账本。CPU首次无差值时为未知；显存取GPU0总量和使用量，WDDM逐进程占用不猜测。进程采样明确只代表当前中枢进程，不能据此声称采全了DSH/QQ/模型进程树。无新文字的任务观察不能证明卡死。

结果未知的本地模型请求保留预算和来源，不能自动重发或按TTL释放。模型缓存回收必须有中枢创建来源及实际空队列证据；不终止其他Python/Node进程、不关闭用户软件、不在轮询时重启模型。资源占用或排队会阻止不安全中枢重载。

## 文件操作范围

POST /api/file-operations/preview生成计划；GET /api/file-operations/:id读取状态；commit/undo/reconcile/cancel需要明确confirmed:true。取消仅允许未执行预览，不终止正在执行的文件动作。HTTP写操作沿用中枢来源校验。

默认只管理runtime/workspaces内选定的独立子目录；归档库、QQ接收区与远端接收区受保护。支持所选范围内已有非符号链接子目录之间移动文件；不创建目录。重命名/移动使用独占目标硬链接后移除原链接，目标不覆盖，跨卷返回不支持。重复识别以SHA-256及大小确认，只返回候选，不删除。

执行与撤销均检查根目录和双侧父目录dev/ino身份、逐路径组件、内容与版本；中断后先核对现状，不盲重试。Node按路径的文件系统调用不能钉住目录句柄，无法承诺抵抗其他进程恶意同时换树；操作期间应保持选定目录位置稳定。本轮只在临时测试目录真实验收，没有整理个人文件。

## 设备视图

GET /api/devices/management汇总本机任务、既有远端设备/权限和逐设备桌面租约。远端已接收与原生任务已完成分开，只有现有HTTP接收回执时完成状态保持未知。离线、数据过期、未报告能力分别显示；过期租约仍是uncertain，不自动当成空闲。

本接口不派发任务，不把远端操作转给本地DSH，不更改原生工作路由。旧客户端缺少的遥测显示未知，不能根据版本号推定功能已授权。离线设备的真实输入、结果及接管验收另记待验证。

本机任务分开显示中枢收件、原生接收、近期原生活动和完成结果。排队/运行/等待/中断状态以及createdAt都不能单独证明原生已接收。当前只读DSH接收事件必须位于最近task.started之后，并绑定相同任务、会话和runVersion；Codex原有session事件发生在turn/start之前，不能作为接收证据，因此缺少后续可核验事件时保持未知。近期活动只表明观察时有活动，不保证当前仍执行；中断后不沿用执行中状态。

历史中断记录折叠展示，不改原始任务历史。新页面兼容旧接口：仅有旧accepted:true而没有明确nativeAcceptance证据的本机记录显示原生接收未知，避免后端尚未安全加载时继续误报。

## 安全维护与历史预算

GET /api/system/maintenance展示已加载版本、磁盘版本、实际活动、恢复预约和核对记录。GET只读，不唤醒绘图或唱歌。POST /api/local-resources/reconcile是显式核对：仅匹配原提交后端来源且实时队列完整为空、原任务与调度代次未变化时，释放历史绘图预算并持久记录证据；绘图结果和发送结果仍保持未知。老记录没有来源时继续pending，不拿另一个后端的空队列替代证据。

恢复预约不等于真实执行占用，也不能按TTL直接消除。当前进程没有核对入口时需要正常退出后重新打开，新版不会重放旧请求。每次冷恢复重新保护未决资源，旧空闲证据不直接跨重启复用。
