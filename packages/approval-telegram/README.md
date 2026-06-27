# `@fentaris/approval-telegram`

Telegram approve/deny integration for Fentaris policy permissions.

## Install

```bash
npm install @fentaris/approval-telegram
```

## Quick start

```ts
import { telegramApproval } from "@fentaris/approval-telegram";
import { policy } from "@fentaris/core";

const maintainers = policy("maintainers")
  .mcp("github")
  .allow("delete_repo", telegramApproval({
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_APPROVAL_CHAT_ID ?? "",
    reason: "Repository deletion requires approval",
  }));
```

The adapter fails closed when Telegram delivery fails. Production deployments should validate webhook secrets and use a durable approval store.

See the [Telegram approval guide](https://fentaris.mintlify.app/guides/telegram-approval) for callbacks, stable request IDs, webhook validation, and testing.
