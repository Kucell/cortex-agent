"""Exercise the real helper process with a full, unread OS stdout pipe.

Run after build with DOTNET_CLI_HOME and TMPDIR under .agent/runtime.
On Windows this requires Python 3.12+ for nonblocking anonymous pipes.
"""
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
HELPER = (ROOT / ".agent/runtime/permit-witness-windows/artifacts/bin/"
          "PermitWitness.Windows/Debug/net10.0-windows/PermitWitness.Windows.dll")


def full_pipe_test(args, expected):
    read_fd, write_fd = os.pipe()
    try:
        os.set_blocking(write_fd, False)
        fill = b"\xa5" * 4096
        filled = 0
        # A large atomic write can fail while a few bytes still fit. Finish
        # with single-byte writes so even a small refusal frame would block.
        for block in (fill, fill[:1]):
            while True:
                try:
                    filled += os.write(write_fd, block)
                    if filled > 16 * 1024 * 1024:
                        raise AssertionError("pipe did not reach backpressure")
                except BlockingIOError:
                    break
        if filled == 0:
            raise AssertionError("failed to fill pipe")
        # The child must inherit a blocking write end, with its reader held
        # open and deliberately unread throughout the child's lifetime.
        os.set_blocking(write_fd, True)
        started = time.monotonic()
        process = subprocess.Popen(["dotnet", str(HELPER), *args], stdin=subprocess.DEVNULL,
                                   stdout=write_fd, stderr=subprocess.PIPE)
        try:
            _, stderr = process.communicate(timeout=1.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError("helper blocked while stdout pipe was full")
        elapsed = time.monotonic() - started
        if process.returncode != expected or stderr:
            raise AssertionError(f"unexpected exit={process.returncode}, stderr={stderr!r}")
        os.close(write_fd)
        write_fd = -1
        received = 0
        while True:
            chunk = os.read(read_fd, 65536)
            if not chunk:
                break
            if chunk != b"\xa5" * len(chunk):
                raise AssertionError("helper emitted unexpected stdout")
            received += len(chunk)
        if received != filled:
            raise AssertionError(f"unexpected stdout size: {received} != {filled}")
        print(f"PASS full pipe, {filled} bytes, exit {expected}, {elapsed:.3f}s")
    finally:
        os.close(read_fd)
        if write_fd != -1:
            os.close(write_fd)


if __name__ == "__main__":
    if not HELPER.is_file():
        sys.exit("build helper before running this test")
    full_pipe_test([], 78 if os.name == "nt" else 69)
    full_pipe_test(["--authenticated=true"], 64)
