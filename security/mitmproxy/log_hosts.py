"""mitmproxy addon: record every upstream destination (host, port, TLS or plain). TLS is passed through untouched,
so nothing is decrypted and the app's own certificate checks stay in force; this audits *where* the app connects."""
import json, os
OUT = os.environ.get("ZEN_HOSTS_OUT", "/tmp/zen-hosts.jsonl")
seen = set()
def _record(kind, host, port):
    key = (kind, host, port)
    if key in seen: return
    seen.add(key)
    with open(OUT, "a") as f: f.write(json.dumps({"kind": kind, "host": host, "port": port}) + "\n")
def http_connect(flow):
    _record("tls-tunnel", flow.request.host, flow.request.port)
def tls_clienthello(data):
    data.ignore_connection = True
def request(flow):
    if flow.request.scheme == "http": _record("plain-http", flow.request.host, flow.request.port)
