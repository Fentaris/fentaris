import { profiler, type RuntimeEventMap, type RuntimeEventName } from "@fentaris/core";

const eventName: RuntimeEventName = "mcp.call.timeout";
type TimeoutEvent = RuntimeEventMap["mcp.call.timeout"];
void eventName;

profiler().on("mcp.call.timeout", (event) => {
  const timeout: number = event.timeoutMs;
  const duration: number = event.durationMs;
  const operation: string = event.operation;
  void timeout;
  void duration;
  void operation;
});

profiler().on("policy.denied", (event) => {
  const allowed: boolean = event.allowed;
  void allowed;
});

const timeoutEvent = {} as TimeoutEvent;
const timeoutMs: number = timeoutEvent.timeoutMs;
void timeoutMs;
