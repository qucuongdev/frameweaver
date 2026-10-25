"""Serialize local TTS and manage isolated, reusable model processes."""
import asyncio
import json
import os
import queue
import subprocess
import threading
import time

TTS_SEMAPHORE = asyncio.Semaphore(1)


class ManagedTTSWorker:
    """Reuse one isolated model process with timeout and idle memory cleanup."""

    def __init__(self, engine, python, cache_dir, model, script, env=None):
        self.engine, self.python, self.cache_dir = engine, python, cache_dir
        self.model, self.script, self.env = model, script, env or {}
        self._lock = threading.Lock()
        self._process = None
        self._idle_timer = None
        self.state = "idle"
        self.error = None
        self._probe = None
        self._probe_time = 0.0
        self._generation = 0
        self.idle_timeout = 600

    def _stop(self):
        if self._idle_timer:
            self._idle_timer.cancel()
            self._idle_timer = None
        proc, self._process = self._process, None
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            for pipe in (proc.stdin, proc.stdout):
                if pipe:
                    pipe.close()
        self.state = "idle"

    def close(self):
        with self._lock:
            self._stop()

    def abort(self):
        """Interrupt inference during server shutdown, before waiting for the lock."""
        proc = self._process
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

    def _expire(self, generation):
        with self._lock:
            if generation == self._generation:
                self._stop()

    def _start(self, allow_download=False):
        if self._process and self._process.poll() is None:
            return
        self._stop()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # New process, new log: prevents unbounded log growth over time.
        log = self.cache_dir / "worker.log"
        env = {**os.environ, "HF_HOME": str(self.cache_dir / "huggingface"),
               "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false", **self.env}
        # Once prepared, use the downloaded snapshots without depending on the network.
        if (self.cache_dir / "ready.json").is_file() and not allow_download:
            env["HF_HUB_OFFLINE"] = "1"
        else:
            env.pop("HF_HUB_OFFLINE", None)
        with log.open("w") as stderr:
            self._process = subprocess.Popen(
                [self.python, "-I", "-u", str(self.script)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, env=env, bufsize=0,
            )

    def _item_timeout(self, item):
        return None

    def generate(self, args: dict, callback=None) -> list[dict]:
        with self._lock:
            self._generation += 1
            if self._idle_timer:
                self._idle_timer.cancel()
            try:
                # Cloning needs extra speaker/codec encoder artifacts. Preset-only
                # workers may have started offline before these were downloaded.
                if args.get("allow_download"):
                    self._stop()
                self._start(allow_download=args.get("allow_download", False))
                self.error = None
                proc = self._process
                payload = {**args, "model": self.model, "ready_file": str(self.cache_dir / "ready.json")}
                data = memoryview((json.dumps(payload, ensure_ascii=True) + "\n").encode("utf-8"))
                while data:
                    data = data[proc.stdin.write(data):]
                proc.stdin.flush()
                deadline = time.monotonic() + int(os.environ.get(f"{self.engine.upper()}_LOAD_TIMEOUT", "1800")) + 240 * len(args["items"])
                items = {item["id"]: item for item in args["items"]}

                line_queue = queue.Queue()

                def _reader():
                    try:
                        for raw_line in iter(proc.stdout.readline, b""):
                            line_queue.put(raw_line)
                    except Exception:
                        pass
                    finally:
                        line_queue.put(None)

                reader_thread = threading.Thread(target=_reader, daemon=True)
                reader_thread.start()

                while time.monotonic() < deadline:
                    try:
                        raw_line = line_queue.get(timeout=1.0)
                    except queue.Empty:
                        if proc.poll() is not None:
                            raise RuntimeError(f"Tiến trình {self.engine} đã dừng. Xem {self.cache_dir}/worker.log.")
                        continue
                    if raw_line is None:
                        raise RuntimeError(f"{self.engine} mất kết nối. Xem {self.cache_dir}/worker.log.")
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line.decode("utf-8", errors="replace"))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("event") == "result":
                        if event.get("error"):
                            raise RuntimeError(event["error"])
                        self.state = "ready"
                        return event["results"]
                    self.state = event.get("stage", "generating")
                    if self.state == "generating" and "completed" not in event and event.get("id") in items:
                        timeout = self._item_timeout(items[event["id"]])
                        if timeout is not None:
                            deadline = time.monotonic() + timeout
                    if callback:
                        callback(event)
                raise TimeoutError(f"{self.engine} quá thời gian xử lý. Có thể thử lại từng cảnh ngắn hơn.")
            except Exception as exc:
                self._stop()
                self.error = str(exc)
                raise
            finally:
                if self._process:
                    self._idle_timer = threading.Timer(self.idle_timeout, self._expire, args=(self._generation,))
                    self._idle_timer.daemon = True
                    self._idle_timer.start()
