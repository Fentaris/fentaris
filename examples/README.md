# Examples

Standalone, self-contained TypeScript examples that demonstrate running
TypeScript files in this repository. They do **not** import anything from
the `@fentaris/*` workspace packages and can be executed on their own.

## `hello-world.ts`

A minimal, dependency-free script that prints exactly:

```
Hello, world!
```

### Requirements

- **Node.js `>= 24`** (as declared in the root `package.json` `engines` field).
  Node 24 can execute `.ts` files directly via built-in type stripping, so
  no transpilation step is required.
- **pnpm** (the repository's package manager, pinned via `packageManager` in
  the root `package.json`) is only needed if you want to run validation
  through the workspace scripts.

### Run it

From the repository root, using Node's built-in TypeScript support:

```bash
node examples/hello-world.ts
```

Expected output:

```
Hello, world!
```

### Run it on older Node versions (< 24)

If you are on Node 22.6 – 23.x, enable the experimental type-stripping flag:

```bash
node --experimental-strip-types examples/hello-world.ts
```

On Node < 22.6, compile first with the workspace's TypeScript and run the
emitted JavaScript:

```bash
./node_modules/.bin/tsc examples/hello-world.ts \
  --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --skipLibCheck --outDir .tmp-examples
node .tmp-examples/hello-world.js
```

### Validate

Type-check the example against the repository's TypeScript settings:

```bash
./node_modules/.bin/tsc --noEmit \
  --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --skipLibCheck --types node \
  examples/hello-world.ts
```

The example is intentionally excluded from the workspace `tsc --build`
project references (which cover only `packages/core` and `packages/cli`),
so it is validated independently as shown above.
