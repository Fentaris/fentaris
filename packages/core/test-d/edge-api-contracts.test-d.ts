import { edge, fentaris, runtime, stdio } from "@fentaris/core";
import type {
  FolderSetupField,
  SecretSetupField,
  SetupFieldDescriptor,
} from "@fentaris/core";

const folder = edge.folder({ access: "read" });
const folderKind: FolderSetupField["kind"] = folder.kind;
const folderAccess: FolderSetupField["access"] = folder.access;
const folderDescriptor: SetupFieldDescriptor = folder;
void folderKind;
void folderAccess;
void folderDescriptor;

const secret = edge.secret();
const secretKind: SecretSetupField["kind"] = secret.kind;
const secretDescriptor: SetupFieldDescriptor = secret;
void secretKind;
void secretDescriptor;

const app = fentaris();

app.mcp("filesystem", {
  transport: stdio({
    command: "filesystem-mcp",
    args: ["--workspace", runtime.input("workspace")],
    env: { API_TOKEN: runtime.secret("token") },
  }),
});

app.mcp("filesystem").setup({
  workspace: edge.folder({ access: "read-write" }),
  token: edge.secret(),
  mode: edge.select({ options: ["safe", "full"], default: "safe" }),
});

app.target("personal-device", edge({
  device: edge.userDefaultDevice(),
}));

app.mcp("filesystem").target("personal-device");
