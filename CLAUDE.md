# Haul

Self-hosted download manager: Rust server (`crates/haul`), React UI (`ui`), hoster plugins in
TypeScript (`plugins/*`, SDK in `packages/plugin-sdk`). Docs for developers: `docs/architecture.md`,
`docs/plugins.md`, `docs/development.md`.

- Hoster plugins (new hoster, broken plugin, custom plugin for `/config/plugins`): follow the
  `hoster-plugin` skill in `.claude/skills/hoster-plugin/SKILL.md`.
- Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --all --check`, `pnpm test`, `pnpm typecheck`.
- Texts the user sees are always German and English (`ui/messages/{de,en}.json`, `bilingual()`
  in plugins).
