"""Record the guided tour as an MP4.

Playwright opens the simulator's own guided tour against a running server, hands
it the per-beat durations measured from the narration, and records the window.
Nothing is added in post: every caption, every ring, the title cards and every
number on screen is drawn by the product, and the fourteen tool calls really do
cross a Streamable HTTP socket into a real MCP server, whose results really are
rendered by a sandboxed MCP Apps view.

    CIRCA_PORT=8797 pnpm simulator:dev   # terminal 1: server + simulator
    python demo_video/narrate.py         # terminal 2: voice + timing.json
    python demo_video/record.py          #             this

    python demo_video/record.py --reuse-capture   # re-encode the last take

Output: circa-demo.mp4, 1600x900, H.264/AAC, under three minutes.
"""

from __future__ import annotations

import json
import math
import pathlib
import shutil
import subprocess
import sys

import numpy as np
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
RAW = HERE / "_raw"
VIEWPORT = (1600, 900)
FPS = 30
TAIL_SECONDS = 1.6
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REUSE = "--reuse-capture" in sys.argv
URL = ARGS[0] if ARGS else "http://localhost:5173/?tour=1&manual=1"


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed ({result.returncode}):\n{result.stderr[-4000:]}")


def record(durations: list[int], total_ms: int) -> pathlib.Path:
    if RAW.exists():
        shutil.rmtree(RAW)
    RAW.mkdir(parents=True)
    span_ms = total_ms + int(TAIL_SECONDS * 1000)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--force-color-profile=srgb"])
        context = browser.new_context(
            viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
            device_scale_factor=1,
            record_video_dir=str(RAW),
            record_video_size={"width": VIEWPORT[0], "height": VIEWPORT[1]},
        )
        page = context.new_page()
        page.on("pageerror", lambda e: print(f"  page error: {e}"))
        page.goto(URL, wait_until="load", timeout=60_000)
        page.wait_for_function("() => window.CircaTour?.beats", timeout=60_000)

        beats = page.evaluate("() => window.CircaTour.beats")
        if beats != len(durations):
            raise RuntimeError(f"timing has {len(durations)} beats, the product plays {beats}")

        # Hand the product the narration's pacing, then start its own tour.
        # Fire and forget: start() resolves only when the tour ends, and
        # page.evaluate awaits a returned promise, which would put the timed
        # window over the end screen instead of over the playback.
        page.evaluate("(d) => { window.__CIRCA_TIMING = d; }", durations)
        page.evaluate("() => { window.CircaTour.start(); }")
        page.wait_for_timeout(span_ms)

        video = page.video
        context.close()
        browser.close()
        assert video is not None
        return pathlib.Path(video.path())


def smeared_frames(video: pathlib.Path) -> list[int]:
    """The frame numbers the capture's own encoder softened.

    Playwright's recorder writes a VP8 keyframe on a fixed cadence at a much
    lower quality than the frames around it, so once every few seconds the
    whole picture blurs for a single frame and snaps back. On a page of small
    text that reads as a flicker, and it is not a picture the product ever
    drew. They are found by sharpness: one frame whose edge energy sits well
    below both of its neighbours', while those neighbours agree with each
    other, is the encoder rather than the page.
    """
    w, h = 800, 450
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(video),
         "-vf", f"scale={w}:{h}", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    energy: list[float] = []
    size = w * h
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w).astype(np.int16)
        energy.append(float(np.abs(np.diff(frame, axis=1)).mean()))
    proc.wait()

    found = [
        i for i in range(1, len(energy) - 1)
        if energy[i] < 0.9 * min(energy[i - 1], energy[i + 1])
        and abs(energy[i - 1] - energy[i + 1]) < 0.12 * max(energy[i - 1], energy[i + 1])
    ]
    # Where the page was moving, a softened keyframe hides between two frames
    # that differ anyway and the test above cannot see it. Once the cadence is
    # known from the ones it did see, every frame on that cadence goes.
    period = 0
    for n in found:
        period = math.gcd(period, n)
    if period >= 24 and len(found) >= 5:
        return list(range(period, len(energy) - 1, period))
    return found


def main() -> None:
    timing = json.loads((HERE / "timing.json").read_text(encoding="utf-8"))
    durations: list[int] = timing["durations"]
    total_ms: int = timing["totalMs"]
    narration = HERE / "narration.wav"
    if not narration.exists():
        raise SystemExit("run narrate.py first")

    if REUSE:
        takes = sorted(RAW.glob("*.webm"), key=lambda p: p.stat().st_mtime)
        if not takes:
            raise SystemExit("no capture in _raw/ to reuse")
        raw = takes[-1]
        print(f"re-encoding the last capture, {raw.name}")
    else:
        print(f"recording {len(durations)} beats, {total_ms / 1000:.1f}s + {TAIL_SECONDS}s tail")
        raw = record(durations, total_ms)
        print(f"  raw video {raw.name}")

    smeared = smeared_frames(raw)
    print(f"  {len(smeared)} softened capture frames replaced by the frame before them")

    out = HERE / "circa-demo.mp4"
    seconds = total_ms / 1000 + TAIL_SECONDS
    # Each softened frame is dropped and `fps` fills the gap with its
    # predecessor, so nothing moves and the clock does not shift.
    drop = "+".join(f"eq(n,{n})" for n in smeared) or "0"
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(raw), "-i", str(narration),
        "-filter_complex",
        f"[0:v]select='not({drop})',fps={FPS},"
        f"scale={VIEWPORT[0]}:{VIEWPORT[1]}:flags=lanczos,"
        f"fade=t=in:st=0:d=0.5,fade=t=out:st={seconds - 0.8:.2f}:d=0.8[v];"
        f"[1:a]afade=t=out:st={total_ms / 1000 - 0.6:.2f}:d=0.6[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-t", f"{seconds:.2f}",
        "-movflags", "+faststart",
        str(out),
    ])
    size = out.stat().st_size / 1_000_000
    print(f"\n{out.name}  {seconds:.1f}s  {size:.1f} MB")
    if seconds > 178:
        print("WARNING: over 2:58.")


if __name__ == "__main__":
    main()
