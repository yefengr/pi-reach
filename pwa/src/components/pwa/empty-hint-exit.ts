import { createContext } from "react";

/**
 * 空会话的提示正在原位淡出（DESIGN「动效」的编排）：此时新进入的本端气泡等提示淡出后再进入，
 * 同一时刻只有一个主动作。由 MessageList 提供，UserMessage 只在气泡创建时读取一次。
 */
export const EmptyHintExitContext = createContext(false);
