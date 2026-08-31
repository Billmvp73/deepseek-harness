# Agent Note: 升级 pi-ai 到 0.84.4 并归类其新增的 compat 字段

Status: implemented

[English](2026-08-30-upgrade-pi-ai-0-84-4-classify-compat-fields.md) | 中文

## Problem

`dsh-llm-pi-ai` 把 `@earendil-works/pi-ai` 固定为 `^0.84.2`，其内置 `zai` 目录到 `glm-5.3` 为止，没有 `glm-5.3-flash`。该模型真实且在 Z.ai 已上线——模型代码 `glm-5.3-flash`，一个 320B/18B 激活的原生多模态模型，走 GLM Coding Plan，1M 上下文、128K 最大输出——而 pi-ai 从 `0.84.4` 起才带上它。dsh 的模型选择在运行时读取安装的 pi-ai 目录（`catalogModels` → `getBuiltinModels`），所以只有升级 pi-ai 才能让模型出现；仓库里没有任何硬编码的模型清单。

不过升级 pi-ai 并非一次静默安装。`@earendil-works/pi-ai@0.84.4` 拓宽了三个类型面，而 dsh 在 `llm-pi-ai/src/catalog.ts` 里的编译期 drift 闸门正是故意在有人归类之前把它们编译失败：

- `ChatTemplateKwargValue` 的 `$var` 联合新增了 `thinking.budget`（`CHAT_TEMPLATE_VAR_GATE`）。
- `OpenAICompletionsCompat` 新增了 `thinkingTokenBudgetField: ThinkingTokenBudgetField`（`COMPLETIONS_COMPAT_GATE`）。
- `AnthropicMessagesCompat` 新增了 `allowedFallbackModels?: AnthropicAllowedFallbackModel[]`（`ANTHROPIC_COMPAT_GATE`）。

## Decision

把 `@earendil-works/pi-ai` 升到 `^0.84.4`。provider 集合在 `0.84.2` 与 `0.84.4` 之间一致——`radius` 是纯动态 provider，没有静态目录条目，不在 `getBuiltinProviders()` 里——所以 `experimental/webworker-runtime` pi-ai stub 的 `BUILTIN_PROVIDER_IDS` 清单不变；只有它的版本注释更新为 `0.84.4`。

归类这三个新增的上游成员：

- `thinking.budget` 加入 `CHAT_TEMPLATE_VAR_GATE`（一个新的请求状态占位符，与已有的 `thinking.enabled`/`thinking.effort` 同类）。
- `thinkingTokenBudgetField` 在 `COMPLETIONS_COMPAT_GATE` 里是 `'offer'`。其上游文档明确它「默认关闭；不在生成的目录上设置」，因此一个手工声明的、基于 token 的网关必须能自己声明它——这正是 `offer` 的用例。它获得一个 `PiAiThinkingBudgetField` 类型、一个仿照 `MAX_TOKENS_FIELDS` 的 `THINKING_BUDGET_FIELD_GATE` + `THINKING_BUDGET_FIELDS` drift 闸门、一个 `PiAiCompatProfile.thinkingTokenBudgetField` 成员，以及一个 `compatProfile` schema 成员。三种拼写为 `thinking_token_budget`（vLLM）、`thinking_budget`（Qwen/DashScope/SGLang）和 `thinking_budget_tokens`（llama.cpp）；`supportsThinkingTokenBudget` 继续作为 vLLM 的布尔别名。
- `allowedFallbackModels` 在 `ANTHROPIC_COMPAT_GATE` 里是 `'withhold'`。pi-ai 自己生成的 `anthropic` 目录已经设置了它（`claude-opus-5` 路径带一份回退清单），因此这是「pi-ai 的内置目录已为命名厂商设置它」的情形，部署通过点名该目录路由来触达，而不是手工配置。由于被 withhold，它不占用 `PiAiCompatProfile` 成员。

## Consequences

- 模型选择界面现在在 `zai` 路由下提供 `glm-5.3-flash`（id `glm-5.3-flash`），而在 pi-ai 0.84.4 上，openrouter 路由重新带上整条 `z-ai/glm-*` 家族，包括 `z-ai/glm-5.3-flash` 与 `z-ai/glm-5.3-flash:batch`；`glm-5.3-highspeed` 也加入 `zai` 目录。这正是「一次只为加模型而做的升级也会触发 drift 闸门」的原因：pi-ai 的目录条目增长，其类型外壳也随之拓宽。
- profile 现在可以在 completions 路由/模型上声明 `thinkingTokenBudgetField`，对在推理与答案之间共享 `max_tokens` 的 vLLM/Qwen/SGLang/llama.cpp 网关有用。
- 一个 Anthropic 兼容的手工声明路由不能设置 `allowedFallbackModels`；对 pi-ai 自身的 `anthropic` 目录路由，该值从目录条目带入。点名目录 provider 是受支持的路径。
- drift 闸门仍是它们本来的守门人：未来任何 pi-ai 类型拓宽都会在此处编译失败，直到被归类，因此 `offer`/`withhold` 的提供集合永远不会静默落后于上游。

## Alternatives considered

**不归类这些漂移字段，并把 pi-ai 固定在 0.84.2。** 模型会一直缺席；给选择界面加一个目录模型没有纯配置的绕行办法，因为 `buildModelCatalog` 从安装目录枚举 `listModels`。

**把 `thinkingTokenBudgetField` withhold。** 否决，因为 pi-ai 文档声明它不在生成目录上设置；需要它的网关正是 `offer` 集合为之服务的手工声明路由，而 withhold 会把一个可配置开关从无法以任何其他方式触达它的部署那里藏起来。

**把 `allowedFallbackModels` offer。** 否决，因为 pi-ai 自己的目录条目已经为它的命名厂商设置了它，把它暴露成一个可手工配置的开关，会引导 profile 去复述 provider 自有的回退数据——这正是 `withhold` 的理由。

## Testing

`tsc -b packages/llm/llm-pi-ai/tsconfig.json` 与 `tsc -b packages/experimental/webworker-runtime/tsconfig.json` 在升级后的安装上均通过；驱动这些归类的三个编译期闸门错误已消除。`llm-pi-ai/tests/catalog.spec.ts` 对目录大小与模型 id 的断言是**相对于**实时的 `getBuiltinModels('deepseek')` 的，所以在新目录下依然为绿，而不是固定一张快照。
