import { afterEach, beforeEach, expect, it } from "vitest";
import { currentRunReader } from "./currentRunRegistry";
import { NO_CURRENT_RUN } from "../currentRun";

const fsModule = "node:fs/promises";
const fs = await import(/* @vite-ignore */ fsModule);
let root: string;
let read: Awaited<ReturnType<typeof currentRunReader>>;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp("/tmp/dashboard-current-run-"));
  read = await currentRunReader(root);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function open(id: string, manifest = "label: drive\nstarted: '2026-11-05T12:00:00Z'\n") {
  await fs.mkdir(`${root}/runs/${id}`, { recursive: true });
  await fs.writeFile(`${root}/runs/${id}/manifest.yaml`, manifest);
  await fs.symlink(`runs/${id}`, `${root}/next`);
  await fs.rename(`${root}/next`, `${root}/current`);
}

it("reads open, rotated and closed runs from the authoritative symlink and resolved host path", async () => {
  expect(await read()).toEqual(NO_CURRENT_RUN);
  await open("run-1");
  expect(await read()).toEqual({ ok: true, run_id: "run-1", run_dir: `${root}/runs/run-1`, label: "drive", started: "2026-11-05T12:00:00Z", error: null });
  await open("run-2", "label: second\nended: yesterday\n");
  expect(await read()).toMatchObject({ run_id: "run-2", label: "second" });
  await fs.unlink(`${root}/current`);
  expect(await read()).toEqual(NO_CURRENT_RUN);
  await fs.symlink("runs/gone", `${root}/current`);
  expect(await read()).toEqual(NO_CURRENT_RUN);
});

it("reports invalid pointers and corrupt manifests, then recovers when repaired", async () => {
  await fs.mkdir(`${root}/current`);
  await expect(read()).rejects.toThrow("not a symlink");
  await fs.rmdir(`${root}/current`);
  await open("bad", "run: [\n");
  await expect(read()).rejects.toThrow("corrupt");
  await fs.writeFile(`${root}/runs/bad/manifest.yaml`, "label: repaired\n");
  expect(await read()).toMatchObject({ ok: true, label: "repaired" });
  await fs.writeFile(`${root}/runs/bad/manifest.yaml`, "corrupt: true\n");
  await expect(read()).rejects.toThrow("marked corrupt");
  await fs.unlink(`${root}/current`);
  await fs.symlink(root, `${root}/current`);
  await expect(read()).rejects.toThrow("outside the registry");
});

it("distinguishes a missing/non-directory registry from no open run", async () => {
  const absent = await currentRunReader(`${root}/absent`);
  await expect(absent()).rejects.toThrow();
  await fs.writeFile(`${root}/file`, "no");
  const file = await currentRunReader(`${root}/file`);
  await expect(file()).rejects.toThrow("not a directory");
  await expect(currentRunReader("relative")).rejects.toThrow("absolute host path");
});
