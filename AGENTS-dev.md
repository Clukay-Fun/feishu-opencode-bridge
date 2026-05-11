# 开发规范（非运行时）

> 从 AGENTS.md 拆出的通用开发规范，仅在需要时手动参考。

## GitHub And Delivery Rules

- For GitHub pull requests, use Chinese titles and descriptions by default.
- Preferred PR title format: `[codex] <动词><变更主题>`.
- Preferred PR body sections: `变更内容`, `变更原因`, `影响`, `验证`.
- PR body expectations:
  - `变更内容`: summarize the concrete changes.
  - `变更原因`: explain why the change is needed.
  - `影响`: describe user, developer, runtime, or compatibility impact.
  - `验证`: list the commands, tests, or manual checks actually run.
- The repository PR template lives in `.github/PULL_REQUEST_TEMPLATE.md`; follow it unless the user explicitly asks for a different format.
- Existing commit history does not need retroactive renaming; apply the commit naming convention only to new commits going forward.
- Preferred commit title format: `[codex][<type>] <动词><变更主题>`.
- Preferred commit types:
  - `feat`: new feature or capability expansion
  - `fix`: bug fix or compatibility fix
  - `test`: test coverage or test baseline update
  - `refactor`: structural change without intended behavior change
  - `docs`: documentation, design note, or troubleshooting note
  - `ci`: CI, build, container, or deployment workflow change
  - `merge`: merge-main conflict resolution or integration branch merge commit
  - `followup`: feedback-driven or validation-driven follow-up patch
- Post-freeze feature PRs should include the new-feature checklist self-check when relevant.
- Repository hygiene is part of every commit:
  - Keep the codebase organized and clean before committing.
  - Remove temporary files, dead code, dead files, obsolete folders, and unnecessary subfolders created during the task.
  - Do not leave debug artifacts, one-off scratch scripts, generated local outputs, or unused scaffolding in the repository.
  - If a file or folder remains, it should have an active product, test, documentation, release, or maintainer purpose.
  - Review `git status --short` and the staged diff before every commit to ensure unrelated or disposable files are not included.
- Keep updating the same branch and PR while the related feature line is still open and unmerged.
- Once a PR has been merged into `main`, do not reopen or reuse it for follow-up work; create a new branch and a new PR instead.
- Branch workflow:
  - Prefer feature branches for follow-up delivery instead of committing directly to `main`, unless the user explicitly asks for a direct main commit.
  - Branch names should use `codex/<feature-topic>` for product or architecture work, for example `codex/case-workbench-checkpoints`.
  - Large features should stay on one feature branch until the user-facing capability is coherent, then merge and delete the branch.
  - Small independent fixes, docs, tests, or CI patches can use short-lived branches and merge as soon as validation passes.
  - Do not rewrite already pushed `main` history just to retroactively split old work. If past direct-main commits need review, classify them logically by feature line and apply the branch workflow only to new follow-up work.
  - If a branch accumulates unrelated changes, split by new commits or follow-up branches before PR instead of mixing product behavior, docs, and maintenance in one review.
- GitHub Release / portable packaging workflow:
  - Create releases only from a clean `main`; first confirm `git status --short --branch` is clean, `main` is synced with `origin/main`, and `package.json` version matches the corresponding `CHANGELOG.md` entry.
  - Use `v<package.version>` for the release tag. Prefer a Chinese release title in the format `v<version>: <release theme>`.
  - Before publishing, run at least `npm run build` and `npm test`. If a test command fails, distinguish a real test regression from an invalid CLI flag before reporting the result.
  - Default portable package names should be `feishu-opencode-bridge-<platform>-<arch>`. For the current host platform, run `npm run release:portable` and upload the generated archive as a GitHub Release artifact.
  - When multi-platform artifacts are needed, reuse `buildPortablePackage()` from `scripts/release/build-portable.mjs` and pass explicit `platform`, `arch`, and `outRoot` values for `macos-arm64`, `linux-x64`, and `windows-x64`. On non-Windows hosts, a system `zip` command may be used instead of PowerShell for the Windows archive.
  - Write release notes in Chinese. Recommended sections are `重点更新`, `Portable 包`, `首次运行`, and `验证`; the validation section must list only commands and checks that were actually run.
  - Create the release with `gh release create v<version> <artifact...> --repo Clukay-Fun/feishu-opencode-bridge --target main --title "<Chinese title>" --notes-file <notes.md> --latest`.
  - After publishing, verify the result with `gh release view v<version> --repo Clukay-Fun/feishu-opencode-bridge --json tagName,name,url,assets,isDraft,isPrerelease,targetCommitish,publishedAt` and `gh release list --repo Clukay-Fun/feishu-opencode-bridge --limit 5`.
  - Prefer writing release artifacts to `/tmp/feishu-opencode-bridge-release-<version>`. After publishing, run `git status --short --branch` again to ensure temporary archives or notes did not pollute the repository.

## Maintainer Responsibilities

- Treat pull request review, issue triage, release preparation, release notes, and related repository governance as `core maintainer responsibilities`.
- When the user asks for repository maintenance work, this usually includes:
  - pull request review and merge-readiness checks
  - issue classification, priority sorting, and follow-up recommendations
  - release-oriented changelog and version coordination
  - post-release verification, regression follow-up, and maintenance documentation updates
- Keep maintainer work distinct from feature implementation:
  - feature work changes product behavior or architecture
  - maintainer work keeps the repository healthy, reviewable, and releasable
- When summarizing this category in Chinese, prefer the term `核心维护职责`.

## Issue Authoring Rules

- Use issue titles with English type labels and Chinese content:
  - `[Bug] <动词><问题对象>`
  - `[Feature] <动词><能力>`
  - `[Enhancement] <动词><现有能力增强>`
  - `[Tech Debt] <动词><架构或维护问题>`
  - `[Docs] <动词><文档主题>`
  - `[Spike] <动词><调研主题>`
- Do not use `[codex]` in newly created issue titles unless the user explicitly asks to preserve an old style.
- Keep titles concrete and searchable. Prefer verbs such as `修复`、`支持`、`统一`、`抽象`、`补充`、`放宽`.
- Standard issue body sections:
  - `背景`
  - `问题 / 需求`
  - `影响`
  - `期望行为`
  - `建议方案`
  - `验收标准`
  - `非目标`
  - `备注`
- For small, clear bugs, a shorter body is acceptable:
  - `背景`
  - `问题`
  - `影响`
  - `期望行为`
  - `建议方案`
  - `验收标准`
- Issue label guidance:
  - `[Bug]` usually maps to `bug`
  - `[Feature]` and `[Enhancement]` usually map to `enhancement`
  - Add domain labels such as `knowledge-base`, `contract-assistant`, `labor`, or `feishu` when they exist
- For design-heavy issues, prefer the Obsidian knowledge-note style:
  - start with one short defining paragraph or quote block
  - use Chinese headings with optional English hints
  - use `---` between major phases when the issue is long
  - cite source anchors explicitly, for example `源码依据：src/runtime/app.ts -> handleCommand`

## File Header Comment Template

- TypeScript / JavaScript / MJS 文件头注释使用：

```ts
/**
 * 职责: 用一句话说明本文件负责的稳定职责。
 * 关注点:
 * - 说明本文件收口的第一类行为。
 * - 说明本文件保护的边界或复用场景。
 * - 如有必要，说明它不负责什么。
 */
```

- Python 文件头注释使用模块 docstring：

```py
#!/usr/bin/env python3
"""
职责: 用一句话说明本脚本负责的稳定职责。
关注点:
- 说明本脚本收口的第一类行为。
- 说明输入输出协议、fallback 或外部工具边界。
"""
```

- 简单类型定义、纯 re-export、极短测试 fixture 可以不写文件头；一旦文件承载跨模块契约、外部 API 适配、业务 workflow、持久化、配置或脚本入口，就应补文件头。
