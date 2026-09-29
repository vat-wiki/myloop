import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "myanne",
  description: "TypeScript Agent Runtime SDK：Agent 会话、ModelClient、工具循环与事件流",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: undefined,
    nav: [
      { text: "指南", link: "/guide/intro", activeMatch: "^/guide/" },
      { text: "API", link: "/api/", activeMatch: "^/api/" },
      { text: "TUI", link: "/tui/", activeMatch: "^/tui/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "入门",
          items: [
            { text: "设计模型", link: "/guide/intro" },
            { text: "快速开始", link: "/guide/quickstart" },
          ],
        },
        {
          text: "核心概念",
          items: [
            { text: "Skills", link: "/guide/skills" },
            { text: "Agent Extension", link: "/guide/extensions" },
            { text: "Composite Agent", link: "/guide/composite" },
            { text: "Context Compaction", link: "/guide/compaction" },
          ],
        },
        {
          text: "能力",
          items: [
            { text: "Terminal 工具", link: "/guide/terminal" },
            { text: "事件", link: "/guide/events" },
            { text: "多模态消息", link: "/guide/multimodal" },
            { text: "ModelClient", link: "/guide/model-client" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API",
          items: [{ text: "API 概览", link: "/api/" }],
        },
      ],
      "/tui/": [
        {
          text: "TUI",
          items: [{ text: "myanne TUI", link: "/tui/" }],
        },
      ],
    },
    socialLinks: [],
    search: {
      provider: "local",
    },
    outline: {
      label: "页面导航",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最后更新于",
    },
    darkModeSwitchLabel: "主题",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "返回顶部",
    sidebarCollapseLabel: "收起",
    sidebarExpandLabel: "展开",
  },
});
