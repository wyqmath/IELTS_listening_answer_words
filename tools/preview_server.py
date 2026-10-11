"""Serve this folder on localhost; index.html also supports direct opening."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=11545)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]


class LocalPreviewServer(ThreadingHTTPServer):
    # Windows permits overlapping listeners with SO_REUSEADDR; forbid them.
    allow_reuse_address = False


try:
    server = LocalPreviewServer(('127.0.0.1', args.port), partial(SimpleHTTPRequestHandler, directory=str(root)))
except OSError:
    # Opening the launcher twice should reuse this site's existing local server.
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/index.html', timeout=3) as response:
            same_site = response.read() == (root / 'index.html').read_bytes()
    except OSError:
        same_site = False
    if same_site:
        print(f'PREVIEW_URL=http://127.0.0.1:{args.port}/ (already running)', flush=True)
        raise SystemExit(0)
    raise
print(f'PREVIEW_URL=http://127.0.0.1:{server.server_port}/', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
