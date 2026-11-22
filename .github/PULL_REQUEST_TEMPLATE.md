## Summary

<!-- Describe what changed and why. Link any related issue if applicable. -->

## Hardware & OS Tested

- OS: <!-- Linux / macOS / Windows -->
- GPU / Backend / VRAM: <!-- e.g., CPU-only, 1x RTX 4090 (CUDA), 2x ROCm, Apple Metal -->

## Checklist

- [ ] Code uses progressive native TypeScript with `erasableSyntaxOnly: true` (no `enum`, `namespace`, or parameter properties)
- [ ] New or updated code under `engines/` imports gateway utilities ONLY via `platforms/workbench/lib/engine-sdk`
- [ ] `npm --prefix platforms/workbench run typecheck` passes
- [ ] `npm --prefix platforms/workbench run format:check` passes (Prettier)
- [ ] `npm --prefix platforms/workbench run check:cycles` reports zero import cycles
- [ ] `python .workbench/scripts/check-project.py` (or `./lab check`) passes
- [ ] Relative Markdown links updated and verified
