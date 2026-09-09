import { homedir } from "node:os";
import path from "node:path";

export function resolveSharedUploadSocket(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const dataHome = environment.XDG_DATA_HOME?.trim() ||
    path.join(homedir(), ".local", "share");
  const base = path.join(dataHome, "ai-remote");
  return path.resolve(
    environment.AI_REMOTE_UPLOAD_SOCKET?.trim() || path.join(base, "upload.sock"),
  );
}
