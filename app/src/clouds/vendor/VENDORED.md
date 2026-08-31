# Vendored point-cloud viewer

Source: `github.com/christomaszewski/cloud-viewer` (local checkout `~/ws/cloud_viewer`),
commit `0c3fd40` ("Add orthographic projection toggle", 2026-08-31).

Copied VERBATIM (keep it that way — verbatim files make re-syncing a plain copy):
- `core/{PointCloudViewer,colormaps,utm,BasemapLayer}.ts`  ← upstream `src/core/`
- `loaders/{types,bpf,index,loadWorker}.ts`                ← upstream `src/loaders/`
- `bpf.test.ts`, `utm.test.ts`                             ← upstream `tests/` (import paths adapted)
- `bpfWrite.mjs`                                           ← upstream `tools/` (test-only BPF writer)

Local deltas (each marked `VENDOR DELTA` in-line) — re-apply after a re-sync:
- `core/PointCloudViewer.ts`: scene background 0x14171c → 0x0b0e14 and grid colors retoned to
  match the dashboard theme.

Deliberately NOT copied: upstream `src/main.ts` + `src/style.css` (vanilla-DOM chrome and a
clashing `:root` token set — the React chrome lives in `../CloudsTab.tsx`, styled by the
dashboard's own tokens; upstream's `[hidden]{display:none!important}` rule would break the
Shell's CSS-only tab hiding).

Re-sync procedure: copy the files listed above from a clean upstream checkout, re-apply the
VENDOR DELTA lines, re-adapt the two test files' import paths, run `npm test`.
