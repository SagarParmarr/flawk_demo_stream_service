import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SquarePreparation } from "../src/integrations/ffmpeg/square-preparation.js";

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
test("full-range originals convert to verified limited-range square video", async (t) => {
  t.diagnostic(`Media binaries: FFmpeg=${ffmpeg}; FFprobe=${ffprobe}`);
  if (
    spawnSync(ffmpeg, ["-version"], { timeout: 5000 }).status !== 0 ||
    spawnSync(ffprobe, ["-version"], { timeout: 5000 }).status !== 0
  ) {
    assert.ok(!process.env.FFMPEG_PATH && !process.env.FFPROBE_PATH,
      "Configured FFMPEG_PATH and FFPROBE_PATH must point to runnable binaries");
    t.skip(
      "FFmpeg and FFprobe are required for the real conversion regression",
    );
    return;
  }
  const { stdout: encoders } = await execute(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 5000 });
  for (const encoder of ["libx264", "aac"]) {
    assert.ok(new RegExp(`\\b${encoder}\\b`).test(encoders),
      `${ffmpeg} lacks ${encoder}; configure FFMPEG_PATH in .env.media to a build with libx264 and AAC support`);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "full-range-media-"));
  try {
    const input = path.join(directory, "source.mp4");
    const output = path.join(directory, "prepared.mp4");
    await execute(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24",
      "-t",
      "1",
      "-vf",
      "scale=in_range=tv:out_range=pc",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuvj420p",
      "-color_range",
      "pc",
      input,
    ]);
    const encoder = new SquarePreparation(
      ffmpeg,
      ffprobe,
    );
    const source = await encoder.probe(input);
    assert.equal(
      source.streams?.find((s) => s.codec_type === "video")?.pix_fmt,
      "yuvj420p",
    );
    await encoder.convert(input, output, source, 0.8, 0.2);
    assert.equal(
      (await encoder.probe(output)).streams?.find(
        (s) => s.codec_type === "video",
      )?.pix_fmt,
      "yuv420p",
    );
    assert.ok((await encoder.verify(output)) > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
