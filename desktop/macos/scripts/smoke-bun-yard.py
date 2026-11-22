#!/usr/bin/env python3
"""Exercise native world commands with the signed app in an isolated data directory."""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
from threading import Thread


class YardChatModel(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = request["messages"]
        observed = any(message["role"] == "tool" for message in messages)
        name = "move_cat" if observed else "get_world_state"
        available = {tool["function"]["name"] for tool in request.get("tools", [])}
        if self.path != "/v1/chat/completions" or request.get("stream") or name not in available:
            self.send_error(422, "Unexpected yard chat request")
            return
        arguments = {"destination_id": "pond"} if observed else {}
        response = json.dumps({"choices": [{"finish_reason": "tool_calls", "message": {
            "content": "", "tool_calls": [{"id": "fixture-" + name, "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)}}],
        }}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)
        print(f"小院聊天协议桩：{name}", flush=True)


@contextmanager
def chat_model(enabled):
    if not enabled:
        yield None
        return
    with ThreadingHTTPServer(("127.0.0.1", 0), YardChatModel) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/v1"
        finally:
            server.shutdown()
            worker.join()


def main():
    parser = argparse.ArgumentParser()
    surface = parser.add_mutually_exclusive_group()
    surface.add_argument("--fixture-renderer", action="store_true", help="Use deterministic frames for the receipt path")
    surface.add_argument("--visible-window", action="store_true", help="Bring the temporary XCTest window in front on this Mac")
    parser.add_argument("--skip-build", action="store_true", help="Reuse an existing Swift test build")
    parser.add_argument("--chat-actions", action="store_true", help="Also send a chat command and verify the world receipt")
    parser.add_argument("--scratch-path", type=Path, help="SwiftPM build directory")
    args = parser.parse_args()
    package = Path(__file__).resolve().parents[1]
    helper = runpy.run_path(str(package / "scripts/smoke-bun-backup.py"))
    with tempfile.TemporaryDirectory(prefix="cattt-bun-yard-") as directory, chat_model(args.chat_actions) as endpoint:
        root = Path(directory)
        host = helper["Host"](root / "a", helper["sockets"](3))
        if endpoint:
            host.env.write_text(f"MODEL_PROVIDER=openai-compatible\nCHAT_MODEL=yard-chat-fixture\nOPENAI_COMPAT_BASE_URL={endpoint}\n")
        try:
            host.start()
            config = root / "test.json"
            config.write_text(json.dumps({
                "data": host.data.as_uri(), "bundle": helper["APP"].resolve().as_uri(), "port": host.loopback,
                "lanPort": host.lan, "peerPort": host.peer, "renderer": "fixture" if args.fixture_renderer else "webkit",
                "visibleWindow": args.visible_window,
                "chatActions": args.chat_actions,
            }))
            command = ["swift", "test", "--disable-sandbox", "--package-path", str(package),
                       "--filter", "SharedYardTests/testPackagedWorldBridge"]
            if args.scratch_path:
                command.extend(["--scratch-path", str(args.scratch_path.resolve())])
            if args.skip_build:
                command.append("--skip-build")
            subprocess.run(command, env=dict(os.environ, CATTT_BUN_BRIDGE_CONFIG=str(config)), check=True,
                           timeout=180 if args.skip_build else 900)
        finally:
            host.stop()


if __name__ == "__main__":
    main()
