# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) (pull-request-only) runs the required primary Node 24 jobs on repo-restricted enterprise 16-core pools in the upstream repository. Forks run the same jobs on standard `ubuntu-latest` with lower worker concurrency because enterprise labels do not cross repository ownership. The stable `all checks passed` aggregate uses `ubuntu-latest` unless upstream failover selects the self-hosted pool. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking checks; native Windows jobs use upstream enterprise or self-hosted pools and standard `windows-latest` in forks ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard-hosted jobs retain Node 22.19, Node 26, the Python SDK unit suite, and [installed-wheel Python runtime validation](../testing/2026-08-23-installed-python-wheel-black-box-ci.md) on every published native target, while the serial references (in `ci-master.yml`) remain the complete unsharded cross-platform definitions.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, `windows node 24 / wine blocking`, and the blocking native Windows jobs remain dependencies of `all checks passed`; the observational native Windows job is deliberately absent. Branch protection continues to require `e2e` and `all checks passed`. Upstream does not automatically replace an unavailable enterprise label because standard compatibility jobs cannot manufacture a missing required result. Forks select standard runners before evaluating upstream failover variables so copied workflows never queue against labels they cannot access.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent completeness check, now provided by the self-hosted `vm-backup`/`dsh-win-ci` standby lanes on `master`; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep upstream Linux primary jobs on standard capacity.** This removes the remaining enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. Upstream spends enterprise capacity on the Linux primary critical path; forks accept slower standard capacity instead of inheriting inaccessible labels.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Upstream pull requests spend enterprise capacity on the Linux critical path while forks spend standard hosted capacity and accept lower concurrency. The Wine job keeps its Windows verdict on standard Linux allocation in both repositories. Fork native Windows jobs provide the blocking kernel signal without requiring organization-owned labels. A live exact-head run distinguishes the commands branch protection consumes from the observational contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility and required Wine jobs remain useful when upstream enterprise allocation is degraded, but they do not make a blocked required Linux job or aggregate green. Upstream recovery may require selecting the self-hosted failover pool; changing a pool definition's status alone is insufficient evidence that it can receive work. Forks trade larger-runner speed for CI that starts without repository-external runner configuration.
