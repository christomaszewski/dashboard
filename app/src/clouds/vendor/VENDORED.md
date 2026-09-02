# Vendored point-cloud viewer

Source: `github.com/christomaszewski/cloud-viewer` (local checkout `~/ws/cloud_viewer`),
commit `95aface` ("Add eye-dome lighting, color-scale tone controls, and global opacity",
2026-08-31; previously `0c3fd40`).

Copied VERBATIM (keep it that way — verbatim files make re-syncing a plain copy):
- `core/{PointCloudViewer,colormaps,utm,BasemapLayer}.ts`  ← upstream `src/core/`
- `loaders/{types,bpf,index,loadWorker}.ts`                ← upstream `src/loaders/`
- `bpf.test.ts`, `utm.test.ts`                             ← upstream `tests/` (import paths adapted)
- `bpfWrite.mjs`                                           ← upstream `tools/` (test-only BPF writer)

Local deltas (each marked `VENDOR DELTA` in-line) — re-apply after a re-sync:
- `core/PointCloudViewer.ts`: the underlay scene background 0x14171c → 0x0b0e14 and grid colors
  retoned to match the dashboard theme. (Since 95aface the points render to an offscreen target
  and composite over an "underlay" scene holding the background/grid/basemap — the background
  delta lives on `this.underlay.background`.)

Chrome ported in `../CloudsTab.tsx` (keep in step with upstream `src/main.ts`): color/colormap
+ legend (editable range, auto, γ), alpha-from-attribute + floor, blend mode, global opacity,
EDL + strength, point size/attenuation, ortho, grid, basemap, view presets.

Deliberately NOT copied: upstream `src/main.ts` + `src/style.css` (vanilla-DOM chrome and a
clashing `:root` token set — the React chrome lives in `../CloudsTab.tsx`, styled by the
dashboard's own tokens; upstream's `[hidden]{display:none!important}` rule would break the
Shell's CSS-only tab hiding).

Re-sync procedure: copy the files listed above from a clean upstream checkout, re-apply the
VENDOR DELTA lines, re-adapt the two test files' import paths, run `npm test`.
