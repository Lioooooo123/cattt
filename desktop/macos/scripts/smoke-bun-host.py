#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


PACKAGE = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get("CATTT_BUN_APP", PACKAGE / "build/CatttBunHost.app")).resolve()
BIN = APP / "Contents/MacOS/CatttBunHost"


def within(seconds, check):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if result := check():
            return result
        time.sleep(0.1)
    raise AssertionError("等待超时")


def children(pid):
    return subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


def request(base, path, context=None, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with urlopen(Request(base + path, headers=headers), context=context, timeout=1) as response:
        return json.load(response)


def unexpected_status(status, base, path, **kwargs):
    try:
        request(base, path, **kwargs)
    except HTTPError as error:
        assert error.code == status, error
        return
    raise AssertionError(f"预期 HTTP {status}")


def run(data, port, lan_port, peer):
    return [str(BIN), "--headless", "--data-dir", str(data),
            "--port", str(port), "--lan-port", str(lan_port), "--peer-port", str(peer)]


def reserve_ports():
    with socket.socket() as loopback, socket.socket() as lan, socket.socket() as peer:
        for listener in (loopback, lan, peer):
            listener.bind(("127.0.0.1", 0))
        return tuple(listener.getsockname()[1] for listener in (loopback, lan, peer))


def smoke(root):
    data = root / "host-data"
    data.mkdir(mode=0o700)
    (data / "env").write_text("MODEL_PROVIDER=mock\n")
    # A compiled app launched from its data directory must ignore ambient Bun config.
    (data / ".env").write_text("MOCK_DELAY_MS=invalid\n")
    with socket.socket() as occupied, socket.socket() as other, socket.socket() as peer:
        for listener in (occupied, other, peer):
            listener.bind(("127.0.0.1", 0))
        port, lan_port, peer_port = (listener.getsockname()[1] for listener in (occupied, other, peer))
        occupied.listen()
        collision = subprocess.run(run(data, port, lan_port, peer_port), capture_output=True, text=True, timeout=10)
        assert collision.returncode == 1 and f"端口 {port} 已被占用" in collision.stderr, collision.stderr
        assert not (data / "cattt.db").exists()

    legacy = root / "legacy"
    (legacy / "pg").mkdir(parents=True)
    (legacy / "pg/PG_VERSION").write_text("17\n")
    blocked = subprocess.run(run(legacy, port, lan_port, peer_port), capture_output=True, text=True, timeout=10)
    assert blocked.returncode == 1 and "PostgreSQL" in blocked.stderr, blocked.stderr
    assert list(legacy.iterdir()) == [legacy / "pg"]
    backup = subprocess.run(run(data, port, lan_port, peer_port) + ["--backup"], capture_output=True, text=True, timeout=10)
    assert backup.returncode == 1 and "备份" in backup.stderr, backup.stderr
    importer = subprocess.run([str(BIN.with_name("cattt-host")), "import-pg", "--help"],
                              cwd=root, env={}, capture_output=True, text=True, timeout=10, check=True)
    assert "--target-dir" in importer.stdout and "import-pg" in importer.stdout

    base = f"http://127.0.0.1:{port}"
    https = f"https://127.0.0.1:{lan_port}"
    ca = data / "tls/ca.crt"
    admin = data / "host-admin.token"
    command = run(data, port, lan_port, peer_port)
    with (root / "supervisor.log").open("ab") as output:
        def start():
            # The Mac app must use its explicit data directory even with inherited overrides.
            environment = dict(os.environ, CATTT_DATA_DIR=str(legacy), MODEL_PROVIDER="invalid")
            return subprocess.Popen(command, cwd=root, env=environment, stdout=output, stderr=output)

        def ready(process):
            def probe():
                assert process.poll() is None, f"宿主提前退出 {process.returncode}"
                if not ca.is_file() or not admin.is_file():
                    return None
                try:
                    health = request(base, "/v2/healthz")
                    # Trust only the generated CA and verify the address. Match the
                    # macOS client policy for Cattt's certificates without AKI/SKI.
                    trust = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                    trust.load_verify_locations(cafile=str(ca))
                    secure = request(https, "/v2/healthz", trust)
                    status = request(base, "/host/status", token=admin.read_text().strip())
                except OSError:
                    return None
                assert health == secure and health["ok"] and health["protocol_version"] == 1, health
                assert status["lan"]["enabled"] and status["lan"]["port"] == lan_port, status
                return health, trust

            health, trust = within(20, probe)
            pids = children(process.pid)
            assert len(pids) == 1, pids
            within(10, lambda: "回环和 HTTPS 已就绪" in (root / "supervisor.log").read_text())
            return pids[0], health, trust

        def stop(process):
            if process.poll() is None:
                process.terminate()
            try:
                assert process.wait(timeout=12) == 0
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

        process = start()
        try:
            child, health, trust = ready(process)
            print(f"Swift PID {process.pid} → Bun PID {child}，回环、受信 HTTPS 与管理状态已就绪")
            unexpected_status(401, base, "/host/status")
            unexpected_status(404, https, "/host/status", context=trust, token=admin.read_text().strip())
            duplicate = subprocess.run(command, capture_output=True, text=True, timeout=10)
            assert duplicate.returncode == 1 and "宿主已经运行" in duplicate.stderr, duplicate.stderr
            assert (data / "cattt.db").is_file()
            assert not (data / "pg").exists() and not (data / "backups").exists()
            original_ca, original_token = ca.read_bytes(), admin.read_bytes()
            os.kill(int(child), signal.SIGKILL)
            child = within(20, lambda: next((pid for pid in children(process.pid) if pid != child), None))
            assert ready(process)[1] == health
            assert "等待重启" in (root / "supervisor.log").read_text()
            print(f"子进程故障可见，Bun PID {child} 自动重启后复用宿主身份")
        finally:
            stop(process)
        within(5, lambda: not alive(child))

        process = start()
        try:
            child, restarted, _ = ready(process)
            assert restarted == health and ca.read_bytes() == original_ca and admin.read_bytes() == original_token
            process.kill()
            process.wait(timeout=5)
            within(10, lambda: not alive(child))
            print(f"完整重启复用 SQLite、CA 与管理令牌；Swift 被强杀后 Bun PID {child} 退出")
        finally:
            if process.poll() is None:
                stop(process)

        process = start()
        try:
            child, restarted, _ = ready(process)
            assert restarted == health
        finally:
            stop(process)
        within(5, lambda: not alive(child))
        with socket.socket() as loopback, socket.socket() as lan:
            for listener, address, checked_port in ((loopback, "127.0.0.1", port), (lan, "0.0.0.0", lan_port)):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((address, checked_port))
                listener.listen()
        print("PASS: 临时目录、端口冲突、旧 PG 保护、管理鉴权、重启及进程和端口释放")


def smoke_gui(data):
    port, lan, peer = reserve_ports()
    flags = run(data, port, lan, peer)[2:]
    subprocess.run(["/usr/bin/open", "-gn", str(APP), "--args", *flags], check=True)

    def app_pid():
        for line in subprocess.check_output(["/bin/ps", "-axo", "pid=,command="], text=True).splitlines():
            pid, command = line.split(maxsplit=1)
            if command.startswith(f"{BIN} ") and str(data) in command:
                return int(pid)
        return None

    pid = within(12, app_pid)
    try:
        def ready():
            ca = data / "tls/ca.crt"
            if not ca.is_file():
                return None
            trust = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            trust.load_verify_locations(cafile=str(ca))
            try:
                return request(f"https://127.0.0.1:{lan}", "/v2/healthz", trust)["ok"]
            except OSError:
                return None

        within(12, ready)
        pids = children(pid)
        assert len(pids) == 1, pids
        os.kill(pid, signal.SIGTERM)
        within(12, lambda: app_pid() is None and not alive(pids[0]))
        print(f"PASS: LaunchServices 应用 PID {pid} 与 Bun PID {pids[0]} 完成 HTTPS 检查并退出")
    finally:
        if app_pid() == pid:
            os.kill(pid, signal.SIGKILL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--gui", action="store_true", help="同时验证登录桌面上的 LaunchServices 启动与退出")
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cattt-bun-smoke-") as directory:
        root = Path(directory)
        try:
            smoke(root)
            if options.gui:
                smoke_gui(root / "gui-data")
        except Exception:
            for log in (root / "supervisor.log", root / "host-data/logs/bun.log"):
                if log.is_file():
                    print(log.read_text(), flush=True)
            raise
