## 1. Public API Inventory

- [x] 1.1 Audit current `@fentaris/core` top-level exports and classify them as high-level, advanced, extension contract, or internal compatibility.
- [x] 1.2 Identify any extension contract types that exist internally but are not exported from the documented public entrypoint.
- [x] 1.3 Decide whether additive package subpath exports are needed for extension imports.

## 2. Export And Contract Stabilization

- [x] 2.1 Update public exports so all supported extension contracts are available without deep private imports.
- [x] 2.2 Keep current top-level public imports compatible.
- [x] 2.3 Mark or document internal compatibility barrels so consumers avoid relying on implementation paths.

## 3. Extension Consumer Fixtures

- [x] 3.1 Add a type-level consumer fixture or `tsd` setup for external TypeScript usage.
- [x] 3.2 Add a custom `FentarisTransport` fixture that compiles through public imports.
- [x] 3.3 Add a custom `ProxyExposureTransport` fixture that compiles through public imports.
- [x] 3.4 Add custom `Policy`, `Registry`, `RateLimiter`, `LoggerDriver`, middleware, and event handler fixtures that compile through public imports.

## 4. Documentation And Examples

- [x] 4.1 Document recommended high-level syntax using `fentaris()` and declaration helpers.
- [x] 4.2 Document advanced low-level usage using `createProxy()`, `McpProxy`, `McpServer`, and explicit transports.
- [x] 4.3 Document each supported extension contract with a minimal example.
- [x] 4.4 Add guidance on which APIs are public, advanced, or internal.

## 5. Verification

- [x] 5.1 Run focused extension API type checks.
- [x] 5.2 Run `@fentaris/core` tests.
- [x] 5.3 Run `@fentaris/core` build.
