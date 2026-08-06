# Agent-native Edge Control

This application factory demonstrates policy-filtered inventory, declarative session selection, explicit single-device calls, shared-pool selectors, and bounded parallel fan-out.

Select a ready Xcode worker before transparent calls:

```json
{"name":"edge__select","arguments":{"target":"build-workers","selector":{"requires":{"pool":"workers","features":["xcode"]},"prefer":["lowest-load"]}}}
```

Call one public device explicitly:

```json
{"name":"edge__call","arguments":{"device":{"name":"Mac Studio","inventoryVersion":4},"tool":"builder__check","arguments":{"project":"app"}}}
```

Run the same effective tool over a bounded shared pool:

```json
{"name":"edge__call_many","arguments":{"selector":{"requires":{"pool":"workers","features":["xcode"]}},"tool":"builder__check","arguments":{"project":"app"},"concurrency":2,"deadlineMs":60000,"failurePolicy":"collect"}}
```

The in-memory stores keep the example compact and are not production-ready. Replace every store, channel, pool-selection, and result-correlation adapter with durable multi-instance implementations before deployment.
