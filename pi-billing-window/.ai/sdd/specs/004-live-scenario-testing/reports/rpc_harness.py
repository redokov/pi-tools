#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rpc_harness.py -- manage a `pi --mode rpc` session for live scenario tests.

Each scenario spawns its own RPC process via RpcSession. The process reads
JSONL commands from stdin ({"type":"prompt","message":"/cmd"}) and writes
JSONL responses/events to stdout, captured line-by-line into a raw log file
by a background thread.

Usage (as a driver, not imported):
    python rpc_harness.py <session-id> <session-dir> <raw-log> <script.json>
where <script.json> is a list of steps:
    [{"wait": 12},                    # sleep seconds
     {"send": "/billing-status"},     # prompt with an extension command
     {"send_no_wait": "/settimer 0"},
     {"log_text": "..."},             # print a marker line into raw log
     {"kill": true}]                  # graceful shutdown

Imported usage (scenario drivers):
    from rpc_harness import RpcSession, ArmSnapshot, ARM_LOG, ARMS_JSON
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time

ARM_LOG = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                       "pi-billing-window-arms.log")
ARMS_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                         "pi-billing-window-arms.json")
STATE_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                          "pi-billing-window.json")


def arms_snapshot():
    """Return parsed arms.json map or {} ."""
    try:
        with open(ARMS_JSON, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def state_snapshot():
    """Return parsed state.json or None."""
    try:
        with open(STATE_JSON, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _pi_argv(cmd_args):
    """Return argv launching `pi` portably (npm shim is a .cmd on Windows)."""
    exe = shutil.which("pi")
    if exe is None:
        raise RuntimeError("pi not found on PATH")
    if exe.lower().endswith(".cmd"):
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", exe] + cmd_args
    return [exe] + cmd_args


class RpcSession:
    """A headless pi --mode rpc process that executes /commands immediately."""

    def __init__(self, session_id: str, session_dir: str, raw_log: str,
                 provider: str = "wormsoft",
                 model: str = "wormsoft/zai/glm-5.3-flash"):
        os.makedirs(session_dir, exist_ok=True)
        self.session_id = session_id
        self.raw_log = raw_log
        cmd_args = ["--mode", "rpc",
                    "--provider", provider,
                    "--model", model,
                    "--session-id", session_id,
                    "--session-dir", session_dir]
        cmd = _pi_argv(cmd_args)
        env = dict(os.environ)
        for k in ("PI_MODEL", "PI_PROVIDER", "PI_SESSION_ID", "PI_SESSION_FILE"):
            env.pop(k, None)
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=env)
        self._lines = []
        self._lock = threading.Lock()
        open(raw_log, "ab").close()
        self._t = threading.Thread(target=self._drain, daemon=True)
        self._t.start()

    def _drain(self):
        with open(self.raw_log, "ab") as f:
            for raw in self.proc.stdout:
                f.write(raw)
                f.flush()
                for line in raw.split(b"\n"):
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    if obj.get("type") == "response":
                        with self._lock:
                            self._lines.append(obj)

    def send_cmd(self, message: str, timeout: float = 120.0) -> dict:
        """Write {"type":"prompt","message":<message>} and return the
        response line (waits up to timeout for type=response command=prompt)."""
        payload = {"type": "prompt", "message": message}
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
        self.proc.stdin.write(data)
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"RPC process exited rc={self.proc.returncode} while awaiting response")
            with self._lock:
                for i, r in enumerate(self._lines):
                    if r.get("command") == "prompt":
                        return self._lines.pop(i)
            time.sleep(0.3)
        raise TimeoutError(f"no prompt response within {timeout}s")

    def feed_meta(self, text: str):
        """Append a marker into the raw log for timeline annotations."""
        with open(self.raw_log, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")

    def stop(self) -> None:
        """Graceful shutdown so the session file is flushed."""
        if self.proc.poll() is not None:
            return
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=15)
        except Exception:
            pass
        if self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=15)
            except Exception:
                pass
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass

    def alive(self) -> bool:
        return self.proc.poll() is None


if __name__ == "__main__":
    sid = sys.argv[1]
    sdir = sys.argv[2]
    rlog = sys.argv[3]
    script = sys.argv[4]
    with open(script, "r", encoding="utf-8") as fh:
        steps = json.load(fh)
    session = RpcSession(sid, sdir, rlog)
    try:
        for step in steps:
            if "wait" in step:
                time.sleep(step["wait"])
                print(f"STATUS waited {step['wait']}s", flush=True)
            elif "send" in step:
                r = session.send_cmd(step["send"])
                print(f"STATUS sent {step['send']!r} -> "
                      f"{json.dumps(r, ensure_ascii=False)[:400]}", flush=True)
            elif "send_no_wait" in step:
                payload = {"type": "prompt", "message": step["send_no_wait"]}
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
                session.proc.stdin.write(data)
                session.proc.stdin.flush()
                print(f"STATUS sent_no_wait {step['send_no_wait']!r}", flush=True)
            elif "log_text" in step:
                session.feed_meta(step["log_text"])
                print(f"STATUS log {step['log_text']}", flush=True)
            elif "kill" in step:
                print("STATUS kill requested", flush=True)
                break
    finally:
        session.stop()
    print("DONE", flush=True)
