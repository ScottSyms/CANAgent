export interface ExtensionSenderLike {
  url?: string;
  tab?: { url?: string };
}

/** Provider/account operations are never accepted from a webpage content script. */
export function isTrustedExtensionSender(sender: ExtensionSenderLike, extensionRoot: string): boolean {
  const senderUrl = sender.url ?? sender.tab?.url ?? '';
  return Boolean(extensionRoot && senderUrl.startsWith(extensionRoot));
}
