/**
 * 职责: 覆盖中文自然语言定时任务意图识别 v2。
 * 关注点: 相对时间/绝对时间/周期时间 + 意图判定 + 执行方式推断。
 */
import { describe, expect, it } from "vitest";

import { parseScheduleIntent } from "../src/scheduler/intent-parser.js";

describe("parseScheduleIntent", () => {
  // ============================================================
  // 相对时间
  // ============================================================
  it("parses 1分钟后", () => {
    const result = parseScheduleIntent("1分钟后发个问候给我");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.prompt).toBe("发个问候给我");
    expect(result!.taskMode).toBe("notice-only");
  });

  it("parses 半小时后", () => {
    const result = parseScheduleIntent("半小时后提醒我喝水");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.prompt).toBe("提醒我喝水");
    expect(result!.taskMode).toBe("notice-only");
  });

  it("parses 10分钟后", () => {
    const result = parseScheduleIntent("10分钟后提醒我看合同");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("提醒我看合同");
  });

  it("parses 2小时后", () => {
    const result = parseScheduleIntent("2小时后提醒我回消息");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("提醒我回消息");
  });

  it("parses 3天后", () => {
    const result = parseScheduleIntent("3天后提醒我提交材料");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.prompt).toBe("提醒我提交材料");
  });

  // ============================================================
  // 绝对日期
  // ============================================================
  it("parses 明天上午9点", () => {
    const result = parseScheduleIntent("明天上午9点提醒我开会");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.schedule.expression).toContain("T09:00");
    expect(result!.prompt).toBe("提醒我开会");
    expect(result!.taskMode).toBe("notice-only");
  });

  it("parses 明天下午6点", () => {
    const result = parseScheduleIntent("明天下午6点提醒我准备会议材料");
    expect(result).not.toBeNull();
    expect(result!.schedule.expression).toContain("T18:00");
  });

  it("parses 后天上午10点", () => {
    const result = parseScheduleIntent("后天上午10点提交报告");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.schedule.expression).toContain("T10:00");
  });

  it("parses 今天下午6点", () => {
    const result = parseScheduleIntent("今天下午6点提醒我下班");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.schedule.expression).toContain("T18:00");
  });

  it("parses 下周一上午9点", () => {
    const result = parseScheduleIntent("下周一上午9点提醒我开会");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("once");
    expect(result!.schedule.expression).toContain("T09:00");
  });

  // ============================================================
  // 周期时间
  // ============================================================
  it("parses 每天上午9点", () => {
    const result = parseScheduleIntent("每天上午9点生成今日简报");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("cron");
    expect(result!.schedule.expression).toBe("0 9 * * *");
    expect(result!.prompt).toBe("生成今日简报");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  it("parses 每天下午3点", () => {
    const result = parseScheduleIntent("每天下午3点发送日报");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("cron");
    expect(result!.schedule.expression).toBe("0 15 * * *");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  it("parses 每天晚上8点", () => {
    const result = parseScheduleIntent("每天晚上8点提醒下班");
    expect(result).not.toBeNull();
    expect(result!.schedule.expression).toBe("0 20 * * *");
    expect(result!.taskMode).toBe("notice-only");
  });

  it("parses 每小时", () => {
    const result = parseScheduleIntent("每小时检查项目状态");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("interval");
    expect(result!.schedule.expression).toBe("1h");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  it("parses 每2小时", () => {
    const result = parseScheduleIntent("每2小时检查服务器状态");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("interval");
    expect(result!.schedule.expression).toBe("2h");
  });

  it("parses 每周一上午9点", () => {
    const result = parseScheduleIntent("每周一上午9点总结上周工作");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("cron");
    expect(result!.schedule.expression).toBe("0 9 * * 1");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  it("parses 每周五下午5点", () => {
    const result = parseScheduleIntent("每周五下午5点发送周报");
    expect(result).not.toBeNull();
    expect(result!.schedule.expression).toBe("0 17 * * 5");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  it("parses 每月1号9点", () => {
    const result = parseScheduleIntent("每月1号9点生成月度报告");
    expect(result).not.toBeNull();
    expect(result!.schedule.kind).toBe("cron");
    expect(result!.schedule.expression).toBe("0 9 1 * *");
    expect(result!.taskMode).toBe("opencode-isolated");
  });

  // ============================================================
  // 执行方式推断
  // ============================================================
  it("infers notice-only for 提醒类", () => {
    expect(parseScheduleIntent("明天上午9点提醒我开会")?.taskMode).toBe("notice-only");
    expect(parseScheduleIntent("1分钟后发个问候给我")?.taskMode).toBe("notice-only");
    expect(parseScheduleIntent("每天晚上8点通知我下班")?.taskMode).toBe("notice-only");
    expect(parseScheduleIntent("半小时后叫我喝水")?.taskMode).toBe("notice-only");
  });

  it("infers opencode-isolated for 生成类", () => {
    expect(parseScheduleIntent("每天上午9点生成今日简报")?.taskMode).toBe("opencode-isolated");
    expect(parseScheduleIntent("每周一上午9点总结上周工作")?.taskMode).toBe("opencode-isolated");
    expect(parseScheduleIntent("每小时检查项目状态")?.taskMode).toBe("opencode-isolated");
    expect(parseScheduleIntent("每天下午3点搜索AI新闻")?.taskMode).toBe("opencode-isolated");
  });

  // ============================================================
  // 不拦截的场景
  // ============================================================
  it("returns null for questions about cron", () => {
    expect(parseScheduleIntent("cron 是什么意思")).toBeNull();
    expect(parseScheduleIntent("怎么设计定时任务系统")).toBeNull();
  });

  it("returns null for vague input", () => {
    expect(parseScheduleIntent("帮我设计一个定时任务方案")).toBeNull();
    expect(parseScheduleIntent("以后可以提醒我吗")).toBeNull();
    expect(parseScheduleIntent("这个功能支持定时吗")).toBeNull();
    expect(parseScheduleIntent("做点什么")).toBeNull();
    expect(parseScheduleIntent("")).toBeNull();
  });

  it("returns null for too short input", () => {
    expect(parseScheduleIntent("提醒我")).toBeNull();
    expect(parseScheduleIntent("帮我")).toBeNull();
  });
});
