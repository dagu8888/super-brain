-- Orchestrator 逆迁移（任务包第4包 S1 随交付）：仅 DROP 三张新表，老表一列未动无需逆操作
-- 用法：sqlite3 state.db < migrate_orch_rollback.sql
DROP TABLE IF EXISTS task_links;
DROP TABLE IF EXISTS orch_plans;
DROP TABLE IF EXISTS agent_caps;
