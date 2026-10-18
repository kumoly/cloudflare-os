"""Private NDJSON worker for pinned, offline MinerU Basic. stdout is protocol only."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tempfile

from mineru_normalize import normalize, NormalizationError


def local_only_network():
    # Basic needs no network. Keep local Unix IPC available to native model libraries.
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            raise OSError("NETWORK_DISABLED")
        return original_connect(self, address)
    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            raise OSError("NETWORK_DISABLED")
        return original_connect_ex(self, address)
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex


def initialize():
    if importlib.metadata.version("mineru") != "4.0.12":
        raise ValueError("PARSER_UNAVAILABLE")
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise ValueError("PARSER_UNAVAILABLE")
    local_only_network()
    import torch
    torch.set_num_threads(8)
    torch.set_num_interop_threads(8)
    from mineru.config import config, VlmConfig
    if config.model.source != "local" or config.model.small_backend != "torch" or not Path(config.model.base_dir).is_dir():
        raise ValueError("PARSER_UNAVAILABLE")
    if config.model.vlm.server_url or config.model.vlm.api_key or config.llm_aided.base_url or config.llm_aided.api_key or config.llm_aided.model:
        raise ValueError("PARSER_UNAVAILABLE")
    if config.llm_aided.features.title_leveling or config.llm_aided.features.cross_page_table_cell_merge:
        raise ValueError("PARSER_UNAVAILABLE")
    from mineru.parser import MinerUParser
    from mineru.model.runtime.hybrid import HybridLocalModelContextSingleton
    context = HybridLocalModelContextSingleton().get_model()
    # Preload exactly the local Basic path. No VLM/LLM instance is constructed.
    _ = context.table_orientation_cls_model, context.table_cls_model
    _ = context.wireless_table_model, context.wired_table_model, context.seal_model
    return MinerUParser(tier="basic", parse_mode="auto", image_analysis=False,
                        vlm_config=VlmConfig(server_url="", api_key=""))


def validate_request(request, jobs_root):
    if not isinstance(request, dict) or set(request) != {"id", "directory", "pages", "maxBytes"}:
        raise ValueError()
    if not isinstance(request["id"], str) or not re.fullmatch(r"[a-f0-9-]{36}", request["id"]):
        raise ValueError()
    directory = Path(request["directory"])
    info = directory.lstat()
    if directory.resolve().parent != jobs_root or not re.fullmatch(r"cfos-pdf-[A-Za-z0-9]+", directory.name) or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o777 != 0o700 or info.st_uid != os.getuid():
        raise ValueError()
    source = directory / "input.pdf"
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600 or not 0 < info.st_size <= 16 * 1024 * 1024:
        raise ValueError()
    pages = request["pages"]
    if not isinstance(pages, list) or not 1 <= len(pages) <= 20 or any(type(p) is not int or not 1 <= p <= 200 for p in pages) or len(set(pages)) != len(pages):
        raise ValueError()
    if type(request["maxBytes"]) is not int or not 1 <= request["maxBytes"] <= 8 * 1024 * 1024:
        raise ValueError()
    return directory, source, pages


def main():
    os.umask(0o077)
    args = argparse.ArgumentParser()
    args.add_argument("--jobs-root", required=True)
    options = args.parse_args()
    jobs_root = Path(options.jobs_root).resolve()
    # Redirect native and Python library output at the file-descriptor boundary. Parser logs can
    # contain document text or filenames and must never reach the protocol or host logs.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), sys.stdout.fileno())
        os.dup2(sink.fileno(), sys.stderr.fileno())
    try:
        parser = initialize()
    except BaseException:
        return 1
    protocol.write(json.dumps({"type": "ready", "version": "4.0.12", "tier": "basic"}) + "\n")
    try:
        while True:
            line = sys.stdin.readline(8193)
            if not line:
                break
            if len(line.encode("utf-8")) > 8192 or not line.endswith("\n"):
                return 1
            identifier = None
            result = normalized = payload = None
            try:
                request = json.loads(line)
                identifier = request.get("id") if isinstance(request, dict) else None
                directory, source, pages = validate_request(request, jobs_root)
                with tempfile.TemporaryDirectory(prefix="parser-", dir=directory) as scratch:
                    previous_temp = tempfile.tempdir
                    previous_env = os.environ.get("TMPDIR")
                    tempfile.tempdir = scratch
                    os.environ["TMPDIR"] = scratch
                    try:
                        result = parser.parse(str(source), page_range=",".join(map(str, pages)))
                        normalized = normalize(result.to_dict(skip_defaults=False), pages)
                    finally:
                        tempfile.tempdir = previous_temp
                        if previous_env is None:
                            os.environ.pop("TMPDIR", None)
                        else:
                            os.environ["TMPDIR"] = previous_env
                payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                if len(payload) > request["maxBytes"]:
                    raise NormalizationError("OUTPUT_LIMIT")
                output = directory / "result.json"
                with output.open("xb") as stream:
                    stream.write(payload)
                protocol.write(json.dumps({"id": identifier, "ok": True}) + "\n")
            except BaseException as error:
                code = error.code if isinstance(error, NormalizationError) else "PARSER_FAILED"
                protocol.write(json.dumps({"id": identifier, "ok": False, "errorCode": code}) + "\n")
            finally:
                # Failure paths must erase ParseResult references as well as successful paths.
                result = normalized = payload = None
    finally:
        parser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
