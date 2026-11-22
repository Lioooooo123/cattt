#!/usr/bin/env python3
"""Run backup/restore through the Swift supervisor and compiled Bun product."""
import hashlib
from http.client import HTTPResponse
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4


APP = Path(os.environ.get("CATTT_BUN_APP", Path(__file__).resolve().parents[1] / "build/CatttBunHost.app"))
BIN = APP.resolve() / "Contents/MacOS/CatttBunHost"


def until(check, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if result := check():
                return result
        except OSError:
            pass
        time.sleep(0.1)
    raise AssertionError("等待宿主状态超时")


class Host:
    def __init__(self, data, ports):
        self.data = data
        data.mkdir(mode=0o700)
        self.env = data / "env"
        self.env.write_text("MODEL_PROVIDER=mock\n")
        self.loopback, self.lan, self.peer = ports
        self.command = [str(BIN), "--headless", "--data-dir", str(data),
                        "--port", str(self.loopback), "--lan-port", str(self.lan), "--peer-port", str(self.peer)]
        self.process = None

    def call(self, path, body=None, method=None, phone=None, generation=None, status=200, raw=False, secure=False, admin=True, extra_headers=None):
        headers = {"Content-Type": "application/json", **(extra_headers or {})}
        if phone:
            headers["Authorization"] = "Bearer " + phone
        elif admin and path.startswith("/host/"):
            headers["Authorization"] = "Bearer " + (self.data / "host-admin.token").read_text().strip()
        if generation:
            headers["X-Cattt-Sync-Generation"] = generation
        if secure:
            trust = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            trust.load_verify_locations(cafile=str(self.data / "tls/ca.crt"))
        base = f"https://127.0.0.1:{self.lan}" if secure else f"http://127.0.0.1:{self.loopback}"
        request = Request(base + path, headers=headers, method=method,
                          data=body if isinstance(body, bytes) or body is None else json.dumps(body).encode())
        try:
            response = urlopen(request, timeout=3, context=trust if secure else None)
        except HTTPError as error:
            response = error
        with response:
            assert response.code == status, f"{path}: HTTP {response.code}, 预期 {status}"
            return response.read().decode() if raw else json.load(response)

    def start(self):
        self.process = subprocess.Popen(self.command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return self.ready()

    def ready(self):
        def check():
            if self.process is not None:
                assert self.process.poll() is None, "Swift 宿主提前退出"
            info = self.call("/host/status")
            health = self.call("/v2/healthz")
            secure = self.call("/v2/healthz", secure=True)
            assert secure == health
            return (health, info) if not info["maintenance"] else None
        return until(check)

    def stop(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
        try:
            assert self.process.wait(timeout=15) == 0
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process = None

    def run(self, *args, success=True):
        result = subprocess.run(self.command + list(args), capture_output=True, text=True, timeout=50)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        return result.stdout + result.stderr

    def offline(self, *args, success=True):
        binary = BIN.with_name("cattt-host")
        result = subprocess.run([str(binary), "--restore-command", *args],
                                env={"CATTT_DATA_DIR": str(self.data)}, capture_output=True, text=True, timeout=30)
        assert (result.returncode == 0) == success, args[0]
        return json.loads(result.stdout)

    def verify_maintenance(self, phone, generation, peer, descriptor):
        env = {
            "CATTT_DATA_DIR": str(self.data), "CATTT_PORT": str(self.loopback),
            "CATTT_LAN_HTTPS_PORT": str(self.lan), "CATTT_PEER_HTTPS_PORT": str(self.peer), "MODEL_PROVIDER": "mock",
        }
        child = subprocess.Popen([str(BIN.with_name("cattt-host")), "--supervised", "--restore-check"],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            status = until(lambda: self.call("/host/status"))
            assert status["maintenance"] and status["sync_generation"] == generation
            assert self.call("/v2/healthz", secure=True)["ok"]
            assert self.call("/v2/me", phone=phone, secure=True, status=503)["error"]["code"] == "maintenance"
            self.call("/host/backups", method="POST", status=503)
            self.verify_peer_maintenance(peer, descriptor)
            # The Bun gate cannot be released while the durable restore record still exists.
            child.communicate(b"activate\n", timeout=10)
            assert child.returncode == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def verify_peer_maintenance(self, peer, descriptor):
        version = str(descriptor["protocol_version"])
        server_name = f"{descriptor['host_id']}.peer.cattt"
        trust = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        trust.load_verify_locations(cadata=descriptor["ca_certificate"])
        client = json.loads((peer.data / "peer-tls/identity.json").read_text())
        with tempfile.NamedTemporaryFile(dir=peer.data) as pem:
            pem.write((client["cert"] + "\n" + client["key"]).encode())
            pem.flush()
            trust.load_cert_chain(pem.name)
        with socket.create_connection(("127.0.0.1", self.peer), timeout=5) as sock:
            with trust.wrap_socket(sock, server_hostname=server_name) as tls:
                tls.sendall((f"GET /peer/changes/typed HTTP/1.1\r\nHost: {server_name}\r\n"
                             f"X-Cattt-Peer-Version: {version}\r\nConnection: close\r\n\r\n").encode())
                with HTTPResponse(tls) as response:
                    response.begin()
                    assert response.status == 503
                    assert response.getheader("X-Cattt-Peer-Version") == version
                    assert json.load(response)["error"]["code"] == "maintenance"

    def phone(self):
        member = self.call("/host/members", {"display_name": "甲"})["member"]["id"]
        code = self.call("/host/pairing-codes", {"member_id": member})["code"]
        return self.call("/v2/pair", {"code": code, "device_name": "测试手机"}, secure=True)["device_token"]

    def identity(self):
        identity = self.call("/host/peer-identity")
        identity["address"]["host"] = "127.0.0.1"
        return identity


def sockets(count):
    opened = [socket.socket() for _ in range(count)]
    try:
        for listener in opened:
            listener.bind(("127.0.0.1", 0))
        return [listener.getsockname()[1] for listener in opened]
    finally:
        for listener in opened:
            listener.close()


def query(host, sql, parameters=()):
    with sqlite3.connect(host.data / "cattt.db") as db:
        return db.execute(sql, parameters).fetchall()


def rehash(bundle, path, content):
    payload = bundle / path
    payload.write_bytes(content)
    manifest = bundle / "manifest.json"
    parsed = json.loads(manifest.read_bytes())
    file = next(file for file in parsed["files"] if file["path"] == path)
    file.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    manifest.write_text(json.dumps(parsed))


def verify_yard_bundle():
    root = APP / "Contents/Resources/YardWeb"
    html = (root / "app.html").read_text()
    script = re.search(r'<script[^>]+src="([^"]+)"', html)[1]
    assert "sharedWorld" in (root / script.removeprefix("./").lstrip("/")).read_text()
    expected = json.loads((root / "probe-build.json").read_text())["modelHashes"]
    for model, digest in expected.items():
        data = (root / "models" / (model + ".glb")).read_bytes()
        assert data.startswith(b"glTF") and hashlib.sha256(data).hexdigest() == digest


def upload(host, phone, conversation, payload, partial=False):
    uploads = "/v2/files/uploads"
    digest = hashlib.sha256(payload).hexdigest()
    body = {"client_upload_id": str(uuid4()), "conversation_id": conversation, "sha256": digest,
            "byte_size": len(payload), "file_name": "smoke.txt", "media_type": "text/plain"}
    pending = host.call(uploads, body, phone=phone, secure=True, status=201)
    location = f"{uploads}/{pending['id']}"
    offset = len(payload) // 2 if partial else len(payload)
    host.call(location, payload[:offset], method="PATCH", phone=phone, secure=True,
              extra_headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"})
    if partial:
        return f"blobs/uploads/{pending['id']}", payload[:offset], (body, pending["id"], offset)
    file_id = host.call(location + "/complete", method="POST", phone=phone, secure=True, status=201)["file"]["id"]
    return f"blobs/content/{digest}", payload, file_id


def invite_partner(host):
    try:
        invite = host.call("/host/invites", {"display_name": "乙"})
    except AssertionError:
        return None
    return host.call("/v2/invites/accept", {"code": invite["code"], "display_name": "乙", "device_name": "乙手机"},
                     secure=True)


def main(root):
    verify_yard_bundle()
    ports = sockets(6)
    a = Host(root / "a", ports[:3])
    b = Host(root / "b", ports[3:])
    try:
        a.start()
        b.start()
        phone = a.phone()
        first, joining = a.identity(), b.identity()
        old_head = a.call("/host/status")["sync_generation"]
        opening = a.call("/v2/changes", phone=phone, secure=True)
        assert not opening["reset"] and opening["generation"] == old_head
        changes_route = "/v2/changes?" + urlencode({"cursor": opening["next"]})
        a.call("/host/backups", method="POST", status=401, admin=False)
        a.call("/host/backups", method="POST", status=404, secure=True, admin=False)
        a.call(f"/host/peers/{joining['host_id']}", {
            "identity": joining, "confirmed_fingerprint": joining["fingerprint"], "allow_join": True,
        }, method="PUT")
        b.call("/host/peers/connect", {
            "identity": first, "confirmed_fingerprint": first["fingerprint"], "join_household": True,
        })
        until(lambda: a.call("/host/publication-lease")["status"] == "ready")
        partner = until(lambda: invite_partner(b))["device_token"]
        conversations = a.call("/v2/conversations", phone=phone, secure=True)["conversations"]
        direct = next(item["id"] for item in conversations if item["kind"] == "direct")
        group = next(item["id"] for item in conversations if item["kind"] == "group")
        group_route = f"/v2/conversations/{group}/messages"
        route = f"/v2/conversations/{direct}/messages"
        until(lambda: query(b, "SELECT 1 FROM conversations WHERE id=?", (direct,)))
        b.call(route, phone=partner, secure=True, status=404)
        assert group in {item["id"] for item in b.call("/v2/conversations", phone=partner, secure=True)["conversations"]}
        blob_path, payload, file_id = upload(a, phone, direct, b"completed desktop smoke attachment")
        part_path, partial, (body, upload_id, offset) = upload(a, phone, direct, b"partial desktop smoke attachment", partial=True)
        with sqlite3.connect(a.data / "cattt.db") as reader:
            reader.execute("BEGIN")
            reader.execute("SELECT * FROM messages").fetchall()
            sent = a.call(route, {"text": "备份前", "client_message_id": "before"}, phone=phone, status=201, secure=True)
            stream = sent["turn"]["stream_url"]
            initial_stream = a.call(stream, phone=phone, secure=True, raw=True)
            old_cursor = next(line[4:] for line in initial_stream.splitlines() if line.startswith("id: "))
            checkpoints = a.run("--backup").strip()
            backup = Path(checkpoints.splitlines()[-1])
            with sqlite3.connect(backup / "cattt.db") as db:
                assert db.execute("SELECT count(*) FROM messages WHERE id=?", (sent["message"]["id"],)).fetchone() == (1,)
            reader.rollback()
        manifest = {file["path"]: file for file in json.loads((backup / "manifest.json").read_text())["files"]}
        for path, expected in [(blob_path, payload), (part_path, partial)]:
            assert (backup / path).read_bytes() == expected
            assert manifest[path]["sha256"] == hashlib.sha256(expected).hexdigest()
        assert not (backup / "cattt.db-wal").exists()
        assert (backup / "peer-tls/identity.json").stat().st_mode & 0o777 == 0o600
        peer_old = query(a, "SELECT generation, last_seq FROM replication_state WHERE source_host_id=?", (first["host_id"],))[0]
        a.call(f"/v2/relays/sources/{sent['message']['id']}/withdraw", {"source_revision": 1}, phone=phone, secure=True)
        assert "仍持有数据库" in a.offline("prepare", backup.name, success=False)["error"]
        handoff = {"request_id": str(uuid4()), "expected_epoch": 1}
        until(lambda: transfer(a, joining["host_id"], handoff))
        group_body = {"text": "已跨机送达", "client_message_id": "already-delivered"}
        queued = a.call(group_route, group_body, phone=phone, status=202, secure=True)
        receipt_query = "SELECT status, receipt FROM peer_outbox WHERE status='delivered'"
        delivered = until(lambda: query(a, receipt_query))
        accepted = until(lambda: receipt(a, queued["receipt_url"], phone))
        query(a, "INSERT INTO peer_inbox VALUES (?, ?, ?, ?, ?)",
              (first["household_id"], joining["host_id"], "receipt-fixture", "hash", "committed"))
        query(a, "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              ("done-fixture", "fixture", "{}", "done", 1, 1, 1, None, None, None, 1, 1))
        a.stop()

        # Hash-valid package with a certificate/key pair from different peers:
        # the restored LAN listener fails to bind/verify, so Swift must roll back.
        valid_leaf = (backup / "tls/server.key").read_bytes()
        rehash(backup, "tls/server.key", (b.data / "tls/server.key").read_bytes())
        rejected = a.run("--restore", str(backup), success=False)
        assert "已回退" in rejected, rejected
        assert not (a.data / "restore-pending").exists()
        assert query(a, "SELECT count(*) FROM knowledge_source_withdrawals") == [(1,)]
        a.start()
        assert a.call("/host/status")["sync_generation"] == old_head
        assert a.call("/host/publication-lease")["status"] == "remote"
        a.stop()

        rehash(backup, "tls/server.key", valid_leaf)
        interrupted = a.offline("prepare", backup.name)
        assert (a.data / "restore-pending").is_dir() and interrupted["generation"] != old_head
        a.verify_maintenance(phone, interrupted["generation"], b, first)
        assert a.start()[1]["sync_generation"] == old_head
        assert not (a.data / "restore-pending").exists()
        a.stop()

        result = a.run("--restore", str(backup))
        assert "保留操作前数据库" in result, result
        a.start()
        status = a.call("/host/status")
        fresh = status["sync_generation"]
        assert fresh != old_head
        stale = a.call(route, {"text": "旧游标不能写", "client_message_id": "stale"},
                       phone=phone, generation=old_head, secure=True, status=409)
        assert stale["error"]["code"] == "reset_required" and stale["generation"] == fresh
        assert a.call("/v2/sync-generation", phone=phone, secure=True)["generation"] == fresh
        changes_reset = a.call(changes_route, phone=phone, generation=old_head, secure=True, status=409)
        assert changes_reset == {"reset": True, "generation": fresh, "error": {"code": "cursor_reset_required"}}
        changes_new = a.call("/v2/changes", phone=phone, secure=True)
        assert not changes_new["reset"] and changes_new["generation"] == fresh
        resumed = a.call(stream + "?last_event_id=" + old_cursor, phone=phone, secure=True, raw=True)
        assert "event: snapshot" in resumed and fresh in resumed
        peer_new = query(a, "SELECT generation FROM replication_state WHERE source_host_id=?", (first["host_id"],))[0][0]
        assert peer_new == fresh and peer_new != peer_old[0]
        # The peer may be waiting in the 60-second production outage backoff
        # after the failed candidate and interrupted recovery.
        try:
            until(lambda: query(b, "SELECT generation FROM peer_cursors WHERE source_host_id=?",
                                (first["host_id"],)) == [(peer_new,)], seconds=75)
        except AssertionError:
            sync = next(peer["sync"] for peer in b.call("/host/peers")["peers"]
                        if peer["host_id"] == first["host_id"])
            raise AssertionError(f"peer 未换代，状态={sync['status']}，错误={sync['error_code']}") from None
        assert a.call("/host/publication-lease")["epoch"] == 2
        assert a.call("/host/publication-lease")["status"] == "remote"
        assert query(a, "SELECT count(*) FROM knowledge_source_withdrawals") == [(1,)]
        assert query(a, "SELECT receipt FROM peer_inbox WHERE idempotency_key='receipt-fixture'") == [("committed",)]
        assert query(a, "SELECT status, attempts FROM jobs WHERE id='done-fixture'") == [("done", 1)]
        assert query(a, receipt_query) == delivered
        repeated = a.call(group_route, group_body, phone=phone, secure=True)
        assert repeated["message"]["id"] == accepted["message"]["id"]
        assert query(b, "SELECT count(*) FROM messages WHERE client_message_id='already-delivered'") == [(1,)]
        assert query(a, "SELECT count(*) FROM messages WHERE client_message_id='stale'") == [(0,)]
        a.stop()
        assert a.start()[1]["sync_generation"] == fresh
        assert a.call(f"/v2/files/{file_id}/content", phone=phone, secure=True, raw=True).encode() == payload
        resumed_upload = a.call("/v2/files/uploads", body, phone=phone, secure=True)
        assert resumed_upload["id"] == upload_id and resumed_upload["offset"] == offset
        print("PASS: 包内小院 HTML/JS/GLB、附件哈希、附件下载与续传偏移、成员单聊隔离")
        print("PASS: 两套临时宿主、在线 WAL 备份、坏证书及中断自动回退、手机与 mTLS peer 重置、撤回/租约/收据/已完成 Job、重启")
    finally:
        a.stop()
        b.stop()


def receipt(host, path, phone):
    try:
        return host.call(path, phone=phone, secure=True)
    except AssertionError:
        return None


def transfer(host, target, handoff):
    try:
        return host.call(f"/host/peers/{target}/lease", handoff)
    except AssertionError:
        return None


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cattt-bun-restore-") as directory:
        main(Path(directory).resolve())
