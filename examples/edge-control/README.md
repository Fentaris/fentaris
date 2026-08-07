# Integrated Edge Control Plane

This example enables the supported single-process local Edge control plane with `edge.controlPlane` and starts it with `app.start()`. The application compiles the MCP declaration, setup schema, placement, and target into desired state automatically; there is no application-authored gateway, inventory, resolver, or capability-cache wiring.

Start the application, then authorize an agent:

```bash
fentaris edge approve ABCD-EFGH --subject alice
npx @fentaris/edge join http://127.0.0.1:4000/_fentaris/edge --name "Alice laptop"
```

The new device is reconciled while the application remains running. After the local setup approval, its capabilities become eligible for normal policy-controlled MCP discovery and dispatch.

## Two-user hot plug

Keep the application running and join two agents, approving each code for its real subject:

```bash
fentaris edge approve ALICE-01 --subject alice --yes --json
fentaris edge approve BOB-0002 --subject bob --yes --json
```

The `userDefaultDevice()` selector gives Alice only Alice's approved default device and Bob only Bob's. Each enrollment independently triggers desired-state publication and capability discovery; neither the MCP catalog nor the application process is restarted. Add an administrator group-scoped placement when administrators should receive the broader eligible deployment set—authorization still does not bypass device readiness or manifest gates.

Local mode stores protected authority state under `.fentaris/edge-control-plane` and is intentionally single-process. Use managed adapters for multi-instance production deployments.
