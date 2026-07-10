export const navItems = [
  { key: "start", label: "启动" },
  { key: "overview", label: "总览" },
  { key: "assets", label: "拓扑" },
  { key: "timeline", label: "时间线" },
  { key: "findings", label: "发现" },
  { key: "tools", label: "证据" },
  { key: "flags", label: "Flags" },
  { key: "notes", label: "笔记" },
  { key: "strategy", label: "决策" },
  { key: "teams", label: "协同" },
] as const;

export type NavKey = typeof navItems[number]["key"];
