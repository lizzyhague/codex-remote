export const COMMAND_NAMES = [
  "compact",
  "model",
  "permissions",
  "plan",
  "rename",
  "review",
  "rewind",
  "status",
  "usage",
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

export type CommandDescriptor = {
  name: CommandName;
  title: string;
  description: string;
  action: "confirm" | "options" | "immediate" | "argument";
  confirmation?: string;
};

export const COMMAND_CATALOG: readonly CommandDescriptor[] = [
  {
    name: "compact",
    title: "压缩会话",
    description: "把较早的对话整理成摘要，腾出上下文空间。",
    action: "confirm",
    confirmation: "压缩会把较早的对话整理成摘要，以腾出上下文空间。现在开始吗？",
  },
  {
    name: "model",
    title: "切换模型",
    description: "选择当前会话后续使用的模型。",
    action: "options",
  },
  {
    name: "permissions",
    title: "调整权限",
    description: "选择当前会话允许 Codex 做什么。",
    action: "options",
  },
  {
    name: "plan",
    title: "计划模式",
    description: "进入或退出计划模式；后面也可以直接跟问题。",
    action: "immediate",
  },
  {
    name: "rename",
    title: "重命名会话",
    description: "给当前会话起一个容易找到的名字。",
    action: "argument",
  },
  {
    name: "review",
    title: "检查改动",
    description: "让 Codex 检查当前项目里尚未提交的改动。",
    action: "immediate",
  },
  {
    name: "rewind",
    title: "回退一轮",
    description: "从对话上下文移除最近一轮；不会撤销文件改动。",
    action: "confirm",
    confirmation: "回退会从当前会话移除最近一轮对话，但不会撤销这一轮已经造成的文件改动。确定继续吗？",
  },
  {
    name: "status",
    title: "查看状态",
    description: "显示当前模型、模式、权限和上下文用量。",
    action: "immediate",
  },
  {
    name: "usage",
    title: "查看用量",
    description: "查看账户限额或 Token 使用情况。",
    action: "options",
  },
];

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
