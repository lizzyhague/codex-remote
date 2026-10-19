import { localText, type LocalText } from "../shared/local-text.ts";

export const COMMAND_NAMES = [
  "compact",
  "model",
  "permissions",
  "rename",
  "rewind",
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

export type CommandDescriptor = {
  name: CommandName;
  title: LocalText;
  description: LocalText;
  action: "confirm" | "options" | "argument";
  confirmation?: LocalText;
};

export const COMMAND_CATALOG: readonly CommandDescriptor[] = [
  {
    name: "compact",
    title: localText("command.compact"),
    description: localText("command.compactHint"),
    action: "confirm",
    confirmation: localText("command.compactConfirm"),
  },
  {
    name: "model",
    title: localText("command.model"),
    description: localText("command.modelHint"),
    action: "options",
  },
  {
    name: "permissions",
    title: localText("command.permissions"),
    description: localText("command.permissionsHint"),
    action: "options",
  },
  {
    name: "rename",
    title: localText("command.rename"),
    description: localText("command.renameHint"),
    action: "argument",
  },
  {
    name: "rewind",
    title: localText("command.rewind"),
    description: localText("command.rewindHint"),
    action: "confirm",
    confirmation: localText("command.rewindConfirm"),
  },
];

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
