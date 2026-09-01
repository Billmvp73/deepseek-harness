# Agent Note: 拉取请求 CI 的可移植恢复边界

Status: implemented

[English](2026-07-23-portable-required-pull-request-ci.md) | 中文

## 问题

分配到组织自有运行器标签的拉取请求必需作业，在 GitHub 无法为这些池分配运行器时会持续排队。工作流本身有效，GitHub 标准托管作业仍能通过，但 `all checks passed` 始终无法启动，原本健康的拉取请求因此无法满足分支保护要求。

账单状态正常、运行器定义处于 `Ready` 状态以及较高的自动扩缩容上限，都不能证明指定的运行器池可以接收作业。必需的正确性检查需要预先明确一条可移植恢复路径，即使日常低延迟路径依赖仓库外部的运行器预配也不例外。

## 决策

[CI](../../../../.github/workflows/ci.yml)（仅 pull request）在上游仓库的仅限本仓库使用的企业级 16 核运行器池上运行必需的主 Node 24 作业。fork 使用标准 `ubuntu-latest` 运行相同作业，并降低工作线程并发，因为企业标签不会跨仓库所有权生效。稳定的 `all checks passed` 聚合流程使用 `ubuntu-latest`，除非上游故障切换选择自托管池。必需的 Windows 作业在标准 `ubuntu-latest` 上通过 Wine 运行 Windows Node，覆盖阻断性检查；原生 Windows 作业在上游使用企业级或自托管池，在 fork 中使用标准 `windows-latest`（[双 Windows 决策](2026-08-08-native-windows-pull-request-ci.zh.md)）。标准托管 job 保留 Node 22.19、Node 26、Python SDK 单元测试套件，并在每个已发布原生目标上运行[安装后 wheel Python 运行时验证](../testing/2026-08-23-installed-python-wheel-black-box-ci.zh.md)；串行参考流程（在 `ci-master.yml` 中）仍是完整且未分片的跨平台定义。

三项 Linux 主作业、Node 兼容性、Python SDK 单元测试套件、Python 运行时验证、`windows node 24 / wine blocking` 和阻断性的原生 Windows 作业继续作为 `all checks passed` 的依赖项；观测性原生 Windows 作业被刻意排除。分支保护继续要求 `e2e` 和 `all checks passed`。上游不会自动替换无法分配的企业级标签，因为标准兼容性作业无法产出缺失的必需结果。fork 在评估上游故障切换变量之前选择标准运行器，因此复制的工作流不会排队等待其无权访问的标签。

当前主拓扑及其测量结果以[大型运行器决策](2026-07-22-evidence-based-larger-hosted-runners.zh.md)为准。[跨平台串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)继续作为独立的完整性检查，现由 `master` 上公司自有 `vm-backup`/`dsh-win-ci` 自托管热备通道提供；仅存的托管串行参考是禁用的 `serial-macos`。手动大型运行器套件则保留规格比较，同时不扩大普通必需矩阵。

## 曾考虑的替代方案

**让上游 Linux 主作业使用标准容量。** 此方案消除了剩余的企业级运行器分配依赖，但标准运行器上的完整作业反馈明显更慢，仍会遇到共享容量排队。上游将企业级容量用于 Linux 主关键路径；fork 接受较慢的标准容量，而不是继承其无权访问的标签。

**根据标称核心数选择企业规格。** 基准测试表明扩展效果不呈单调变化，设置耗时也存在波动，因此必需运行器池改由完整作业的精确测量结果选定。

**在容量不可用时跳过检查或降低其级别。** 这种方式通过丢弃证据而非执行仓库的必需约定来使状态变绿。

**在每台主机上使用同一工作线程策略。** 外层门禁并发与内层工具工作线程在 Linux、Windows 和标准运行器上的争用方式不同；按主机实测的上限可以避免新增核心反而拖慢执行。

## 后果

上游拉取请求将企业级容量用于 Linux 关键路径；fork 使用标准托管容量并接受较低并发。Wine 作业在两类仓库中都让 Windows 判定使用标准 Linux 容量。fork 的原生 Windows 作业无需组织自有标签即可提供阻断性的内核信号。一次针对确切分支头的实际运行会区分分支保护采用的命令与观测性约定；排队延迟与每个作业从 `startedAt` 到 `completedAt` 的执行区间分开报告。

上游企业级运行器分配能力下降时，标准兼容性作业与必需的 Wine 作业仍能提供有用证据，但无法让受阻的必需 Linux 作业或聚合流程变绿。上游恢复可能需要选择自托管故障切换池；仅改变运行器池定义的状态，不足以证明它可以接收作业。fork 用大型运行器速度换取无需配置仓库外部运行器即可启动的 CI。
