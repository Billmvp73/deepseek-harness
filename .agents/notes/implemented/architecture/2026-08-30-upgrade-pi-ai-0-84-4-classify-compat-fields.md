# Agent Note: Upgrade pi-ai to 0.84.4 and classify its new compat fields

Status: implemented

English | [中文](2026-08-30-upgrade-pi-ai-0-84-4-classify-compat-fields.zh.md)

## Problem

`dsh-llm-pi-ai` pinned `@earendil-works/pi-ai` at `^0.84.2`, whose installed `zai` catalog ended at `glm-5.3` with no `glm-5.3-flash`. The model is real and live on Z.ai — model code `glm-5.3-flash`, a 320B/18B-active native multimodal model on the GLM Coding Plan, 1M context, 128K max output — and upstream pi-ai carried it from `0.84.4` onward. dsh's model selection reads the installed pi-ai catalog at runtime (`catalogModels` → `getBuiltinModels`), so only a pi-ai bump makes the model appear; nothing in the repo hardcodes the model list.

Bumping pi-ai is not a silent install, though. `@earendil-works/pi-ai@0.84.4` widened three type surfaces that dsh's compile-time drift gates in `llm-pi-ai/src/catalog.ts` intentionally fail on until classified:

- `ChatTemplateKwargValue`'s `$var` union gained `thinking.budget` (`CHAT_TEMPLATE_VAR_GATE`).
- `OpenAICompletionsCompat` gained `thinkingTokenBudgetField: ThinkingTokenBudgetField` (`COMPLETIONS_COMPAT_GATE`).
- `AnthropicMessagesCompat` gained `allowedFallbackModels?: AnthropicAllowedFallbackModel[]` (`ANTHROPIC_COMPAT_GATE`).

## Decision

Bump `@earendil-works/pi-ai` to `^0.84.4`. The provider set is identical between `0.84.2` and `0.84.4` — `radius` is a purely dynamic provider with no static catalog entry, not in `getBuiltinProviders()` — so the `experimental/webworker-runtime` pi-ai stub's `BUILTIN_PROVIDER_IDS` list is unchanged; only its version comment moves to `0.84.4`.

Classify the three new upstream members:

- `thinking.budget` joins `CHAT_TEMPLATE_VAR_GATE` (a new request-state placeholder, same kind as the existing `thinking.enabled`/`thinking.effort`).
- `thinkingTokenBudgetField` is `'offer'` in `COMPLETIONS_COMPAT_GATE`. Its upstream doc confirms it is "off by default; not set on the generated catalog", so a hand-declared token-based gateway must be able to state it — the exact `offer` case. It gets a `PiAiThinkingBudgetField` type, a `THINKING_BUDGET_FIELD_GATE` + `THINKING_BUDGET_FIELDS` drift gate mirroring `MAX_TOKENS_FIELDS`, a `PiAiCompatProfile.thinkingTokenBudgetField` member, and a `compatProfile` schema member. The three spellings are `thinking_token_budget` (vLLM), `thinking_budget` (Qwen/DashScope/SGLang), and `thinking_budget_tokens` (llama.cpp); `supportsThinkingTokenBudget` remains as the vLLM boolean alias.
- `allowedFallbackModels` is `'withhold'` in `ANTHROPIC_COMPAT_GATE`. pi-ai's own generated `anthropic` catalog already sets it (the `claude-opus-5` path carries a fallback list), so it is the "pi-ai's installed catalog already sets it for a named vendor" case and a deployment reaches it by naming the catalog route rather than configuring it by hand. Being withheld, it takes no `PiAiCompatProfile` member.

## Consequences

- The model-selection surface now offers `glm-5.3-flash` under the `zai` route (id `glm-5.3-flash`) and, on pi-ai 0.84.4, the openrouter route re-gains the whole `z-ai/glm-*` family, including `z-ai/glm-5.3-flash` and `z-ai/glm-5.3-flash:batch`; `glm-5.3-highspeed` joins the `zai` catalog too. This is one reason a bump that merely adds a model also trips the drift gates: pi-ai's catalog grew entries, and its type envelope widened alongside.
- A profile may now declare `thinkingTokenBudgetField` on a completions route/model, useful for a vLLM/Qwen/SGLang/llama.cpp gateway that shares `max_tokens` between reasoning and answer.
- An Anthropic-compatible hand-declared route cannot set `allowedFallbackModels`; for pi-ai's own `anthropic` catalog route the value rides in from the catalog entry. Naming the catalog provider is the supported path.
- The drift gates stay the guard they were: any future pi-ai type widening fails the build here until classified, so the `offer`/`withhold` offer set never silently lags upstream.

## Alternatives considered

**Leave the drifting fields unclassified and pin pi-ai at 0.84.2.** The model would stay absent; there is no config-only workaround that adds a catalog model to the selection surface, since `buildModelCatalog` enumerates `listModels` from the installed catalog.

**`withhold` `thinkingTokenBudgetField`.** Rejected because pi-ai documents it as unset on the generated catalog; a gateway that needs it is precisely the hand-declared route the `offer` set exists to serve, and withholding it would hide a configurable switch from a deployment that cannot reach it any other way.

**`offer` `allowedFallbackModels`.** Rejected because pi-ai's own catalog entry already sets it for its named vendor, and exposing it as a hand-configurable switch would invite a profile to restate provider-owned fallback data — the `withhold` rationale verbatim.

## Testing

`tsc -b packages/llm/llm-pi-ai/tsconfig.json` and `tsc -b packages/experimental/webworker-runtime/tsconfig.json` both pass on the bumped install; the three compile-time gate errors that motivate the classifications are gone. `llm-pi-ai/tests/catalog.spec.ts` asserts catalog size and model ids *relative* to the live `getBuiltinModels('deepseek')`, so it stays green under the new catalog rather than pinning a snapshot.
