"""python -m edge  ->  run the edge sidecar on 127.0.0.1:$EDGE_PORT (default 3003)."""
from .server import serve

if __name__ == '__main__':
    serve()
