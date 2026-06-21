---
"@fentaris/core": patch
"@fentaris/cli": patch
---

Harden downstream transport authentication and upstream HTTP networking defaults.

HTTP Streamable and SSE exposure transports now bind session continuations to the authenticated identity, SSE `/messages` requests resolve identity before accepting posts, stdio exposure fails when identity is required but unavailable, and HTTP/SSE listeners bind to `127.0.0.1` unless a host is configured. Upstream HTTP transports now avoid arbitrary env-to-header forwarding and block loopback, link-local, private, and metadata URLs unless explicitly allowed.
