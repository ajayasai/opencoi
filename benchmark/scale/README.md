# Vendor-list scale benchmark

This hardware-reported benchmark exercises OpenCOI's internal vendor-summary
projection at 100, 1,000, and 10,000 vendors. The projection uses one aggregate
SQL statement, eliminating the former per-vendor query growth.

Run it locally:

```bash
npm run benchmark:scale
```

To publish a machine-labelled JSON result:

```bash
npm run benchmark:scale -- --output benchmark/results/scale-local.json
```

The output records the runtime, CPU, memory, workload, warmup count, every
reported population, and latency percentiles. Results are hardware-specific and
are not production capacity guarantees. This workload has no documents or
concurrent writers, and it does not demonstrate horizontal scaling. The stable
`/api/v1/vendors` endpoint additionally uses cursor pagination and a maximum page
size of 100 so integrations never need this unbounded internal projection.
