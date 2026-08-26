import { homedir } from "node:os";
import path from "node:path";

export type SharedUploadPaths = {
  root: string;
  socket: string;
  database: string;
  blobs: string;
  parts: string;
};

export function resolveSharedUploadPaths(
  environment: NodeJS.ProcessEnv = process.env,
): SharedUploadPaths {
  const dataHome = environment.XDG_DATA_HOME?.trim() ||
    path.join(homedir(), ".local", "share");
  const base = path.join(dataHome, "ai-remote");
  const root = path.resolve(environment.AI_REMOTE_UPLOAD_ROOT?.trim() || path.join(base, "uploads"));
  const socket = path.resolve(environment.AI_REMOTE_UPLOAD_SOCKET?.trim() || path.join(base, "upload.sock"));
  return {
    root,
    socket,
    database: path.join(root, "metadata.sqlite"),
    blobs: path.join(root, "blobs"),
    parts: path.join(root, "parts"),
  };
}
