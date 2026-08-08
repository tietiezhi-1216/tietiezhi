import { Icon, type IconProps } from "@iconify/react";
import arrowLeft from "@iconify-icons/lucide/arrow-left";
import arrowRight from "@iconify-icons/lucide/arrow-right";
import bookOpen from "@iconify-icons/lucide/book-open";
import chevronDown from "@iconify-icons/lucide/chevron-down";
import chevronRight from "@iconify-icons/lucide/chevron-right";
import folder from "@iconify-icons/lucide/folder";
import folderOpen from "@iconify-icons/lucide/folder-open";
import kanban from "@iconify-icons/lucide/kanban";
import loader2 from "@iconify-icons/lucide/loader-2";
import logOut from "@iconify-icons/lucide/log-out";
import messageSquare from "@iconify-icons/lucide/message-square";
import messageSquarePlus from "@iconify-icons/lucide/message-square-plus";
import messageCircle from "@iconify-icons/lucide/message-circle";
import moreHorizontal from "@iconify-icons/lucide/more-horizontal";
import paintbrush from "@iconify-icons/lucide/paintbrush";
import panelLeftClose from "@iconify-icons/lucide/panel-left-close";
import panelLeftOpen from "@iconify-icons/lucide/panel-left-open";
import play from "@iconify-icons/lucide/play";
import plus from "@iconify-icons/lucide/plus";
import send from "@iconify-icons/lucide/send";
import settings from "@iconify-icons/lucide/settings";
import users from "@iconify-icons/lucide/users";
import workflow from "@iconify-icons/lucide/workflow";
import x from "@iconify-icons/lucide/x";

const ICONS = {
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,
  "book-open": bookOpen,
  "chevron-down": chevronDown,
  "chevron-right": chevronRight,
  folder,
  "folder-open": folderOpen,
  kanban,
  "loader-2": loader2,
  "log-out": logOut,
  "message-square": messageSquare,
  "message-square-plus": messageSquarePlus,
  "message-circle": messageCircle,
  "more-horizontal": moreHorizontal,
  paintbrush,
  "panel-left-close": panelLeftClose,
  "panel-left-open": panelLeftOpen,
  play,
  plus,
  send,
  settings,
  users,
  workflow,
  x,
} as const;

export type AppIconName = keyof typeof ICONS;

export interface AppIconProps extends Omit<IconProps, "icon"> {
  name: AppIconName;
}

export function AppIcon({ name, ...props }: AppIconProps) {
  return <Icon aria-hidden="true" icon={ICONS[name]} {...props} />;
}
