import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SquarePreparation } from "../src/integrations/ffmpeg/square-preparation.js";

const execute = promisify(execFile);
test("full-range originals convert to verified limited-range square video", async (t) => {
  if (
    spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"]).status !== 0 ||
    spawnSync(process.env.FFPROBE_PATH ?? "ffprobe", ["-version"]).status !== 0
  ) {
    t.skip(
      "FFmpeg and FFprobe are required for the real conversion regression",
    );
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "full-range-media-"));
  try {
    const input = path.join(directory, "source.mp4");
    const output = path.join(directory, "prepared.mp4");
    await execute(process.env.FFMPEG_PATH ?? "ffmpeg", [
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
      process.env.FFMPEG_PATH ?? "ffmpeg",
      process.env.FFPROBE_PATH ?? "ffprobe",
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
