# Performance report

## Status on 2026-10-10

The Linux Mint machine has not been accessible over SSH to this Codex session. Agent idle RSS, idle CPU, startup latency, heartbeat bytes, Docker operation overhead, and end-to-end deployment timing are **not measured**. The requested Linux Mint CPU model, RAM, OS patch level, and Docker version are therefore unknown. No target is claimed as achieved.

## Measurements completed on the development Mac

Development host: 2019 MacBook Pro, Intel Core i9-9880H at 2.30 GHz, 16 GiB RAM, macOS 15.6.1. The production Next.js build completed using Next.js 16.4.0 and Node 22.23.1. PostgreSQL 18.6 ran locally. TypeScript checking, Go unit tests, and the API integration test passed. The Docker daemon was unavailable, so the real Docker lifecycle test was skipped.

The stripped, statically linked Linux amd64 agent binary built on the Mac was 6,684,834 bytes. Binary size is a disk artifact measurement; it does not predict idle RSS or startup time.

The integration test made 100 sequential HTTP requests to each endpoint against one project and one server, after a warm production Next.js start. Client-side wall-clock timings included local HTTP and JSON parsing. These are small-data baseline measurements with no concurrent load:

| Endpoint | Median | p95 |
| --- | ---: | ---: |
| Session lookup | 5.4 ms | 19.6 ms |
| Server listing | 6.1 ms | 22.3 ms |
| Project listing | 5.8 ms | 21.4 ms |
| Overview | 5.2 ms | 21.6 ms |

The earlier local run had p95 values of 4.5–4.9 ms, showing substantial variance even with this tiny test. The other requested API endpoints and dashboard bundle/route metrics have not yet been benchmarked. These numbers do not establish a production p95 target under realistic data or concurrency.

## Method for Linux Mint benchmark

Record `lscpu`, `free -h`, `/etc/os-release`, `docker version`, and agent release SHA. Install the agent and pair it, then leave it idle for at least ten minutes. Sample RSS and CPU from `/proc/<pid>/status` and `pidstat` at one-second intervals, excluding startup. Record requests and bytes at the reverse proxy or with a packet capture. Measure startup from systemd monotonic timestamps. During deployment, record job creation, lease time, pull completion, health completion, and final status timestamps. Run 30 trials of an already-cached image and 10 trials with an uncached image. Report median and p95 separately. Avoid claiming a target from one sample.

For API endpoints, run a local PostgreSQL database with the same schema and a representative data set. Warm the Next.js server, issue at least 1,000 requests per endpoint with modest concurrency, and record p50/p95 plus errors. Measure login, servers, projects, deployment creation, job lease, heartbeat, and status update independently. Bundle sizes can be taken from `.next` output and browser transfer measurements. Log rendering should be profiled with the maximum 200-line response.

## Targets still to verify

Agent idle RSS under 20 MB, idle CPU under 0.5% of one core, startup under 200 ms, ordinary API p95 under 150 ms, and responsive dashboard routes on low-powered devices. These are engineering targets, not current results.
