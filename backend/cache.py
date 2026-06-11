"""Tiny in-process TTL cache so we stay friendly with free data sources."""
import time
import threading
import functools

_store: dict = {}
_lock = threading.Lock()


def ttl_cache(seconds: int):
    """Cache a function's result for `seconds`. Key = function name + args."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = (fn.__module__, fn.__qualname__, args, tuple(sorted(kwargs.items())))
            now = time.time()
            with _lock:
                hit = _store.get(key)
                if hit and now - hit[0] < seconds:
                    return hit[1]
            result = fn(*args, **kwargs)
            with _lock:
                _store[key] = (now, result)
            return result

        return wrapper

    return decorator
