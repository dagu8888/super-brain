# test-agent-worker 心跳丢失处理建议

> 问题：{'agent': 'test-agent-worker', 'last_ts': 1794115543, '_hop': 0, 'subtasks': ['确认 test-agent-worker 心跳丢失事件', '检查该 agent 状态并给出处理建议'], 'route_reason': '心跳丢失事件不属于任何专业 worker 的能力范围，按规则交由 chat-worker 处理。'}

当前知识库中没有关于 `test-agent-worker` 的任何记录，因此无法确认其心跳丢失事件的具体情况，也无法给出针对该 agent 的状态判断。

**处理建议：**
1. **核实来源**：确认心跳丢失告警来自哪个监控系统（如 Prometheus、K8s liveness probe 或自建心跳上报），并检查告警时间窗口内该 agent 的日志与网络连通性。
2. **检查进程与容器状态**：若为容器化部署，执行 `kubectl get pods` / `docker ps` 查看是否处于 CrashLoopBackOff、OOMKilled 或 Pending 状态；若为裸进程，检查 systemd 服务状态与最近重启记录。
3. **排查资源与依赖**：查看 CPU/内存/磁盘是否触顶，以及该 agent 依赖的下游服务（消息队列、数据库、注册中心）是否可用。
4. **确认是否为误报**：心跳丢失也可能是网络抖动或上报间隔配置不当，建议对照历史心跳曲线判断是单次抖动还是持续中断。
5. **处置**：若进程已退出，先保留现场日志再重启；若反复丢失，考虑增加健康检查探针、设置自动重启策略，并将该 agent 纳入统一监控告警。

如需我基于具体日志或监控数据进一步分析，请补充相关信息。
