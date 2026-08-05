/**
 * The slice of the Chrome extension API this extension actually uses.
 *
 * Hand-written rather than `@types/chrome` on purpose. That package declares the whole
 * platform — hundreds of APIs, most of them ones an enterprise reviewer would be
 * alarmed to see a monitoring extension able to call — and the locked stack does not
 * take a dependency where a file will do. Declaring only what is used means the
 * compiler enforces the same restraint the manifest does: reaching for `chrome.cookies`
 * or `chrome.history` here is a type error, not a silent capability.
 *
 * Every declaration below is narrowed to the shape this extension needs, so it is
 * deliberately not a faithful reproduction of the platform's optional arguments.
 */

declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }

    const lastError: LastError | undefined;

    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {
        addListener(callback: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(callback: () => void): void;
      };
    }

    interface Manifest {
      version: string;
      name: string;
    }

    /** Starts the agent in bridge mode. Rejected by Chrome unless the host manifest names us. */
    function connectNative(application: string): Port;
    function getManifest(): Manifest;
    function getURL(path: string): string;

    const onInstalled: {
      addListener(callback: () => void): void;
    };
    const onStartup: {
      addListener(callback: () => void): void;
    };

    interface MessageSender {
      tab?: tabs.Tab;
    }

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };

    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      active: boolean;
      windowId: number;
    }

    interface QueryInfo {
      active?: boolean;
      lastFocusedWindow?: boolean;
      windowId?: number;
    }

    interface ChangeInfo {
      status?: string;
      url?: string;
    }

    function query(info: QueryInfo): Promise<Tab[]>;

    const onActivated: {
      addListener(callback: (info: { tabId: number; windowId: number }) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, change: ChangeInfo, tab: Tab) => void): void;
    };
    const onRemoved: {
      addListener(callback: (tabId: number) => void): void;
    };
  }

  namespace windows {
    /** Reported when every browser window has lost focus — the employee moved to another app. */
    const WINDOW_ID_NONE: number;

    const onFocusChanged: {
      addListener(callback: (windowId: number) => void): void;
    };
  }

  namespace declarativeNetRequest {
    interface RuleCondition {
      /** Matches the listed hosts and their subdomains. No pattern, no regex, no surprises. */
      requestDomains?: string[];
      resourceTypes?: string[];
    }

    interface RuleAction {
      type: "redirect" | "block" | "allow";
      redirect?: { extensionPath?: string };
    }

    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }

    function getDynamicRules(): Promise<Rule[]>;
    function updateDynamicRules(options: {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }): Promise<void>;
  }
}
