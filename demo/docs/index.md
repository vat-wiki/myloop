---
layout: home

hero:
  name: mycoder
  text: Agent Runtime SDK
  tagline: 维护 Agent 会话、调用 ModelClient、执行工具循环，并把运行过程以事件形式暴露给调用方
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 设计模型
      link: /guide/intro

features:
  - icon: 🤖
    title: SingleAgent / CompositeAgent
    details: 单上下文个体与多 Agent 组合个体，coordinator 动态决定委派与结束，用并行 worker 扩大注意力范围
  - icon: 🔌
    title: 多协议 ModelClient
    details: 内置 Anthropic、OpenAI Chat Completions 和 OpenAI Responses 三个协议客户端，支持流式输出、超时重试与 token 用量归一化
  - icon: 💬
    title: 多模态输入
    details: 统一 UserInput 协议，支持文本、图片、文档、视频；本地文件存为 artifact 引用，不污染消息历史
  - icon: 🧰
    title: 原生 bash Terminal
    details: Agent 固定内置 bash 工具，通过 PTY 执行命令，完整事件流覆盖工具生命周期
  - icon: 📦
    title: 确定性上下文压缩
    details: 接近上下文物理上限时自动执行截断与丢弃策略，始终保持 tool_call / tool_result 成对
  - icon: 🧩
    title: Skills 与 Extensions
    details: Skill 组合 system prompt；AgentExtension 提供请求审计、日志脱敏、工具包装等横切扩展点
---
