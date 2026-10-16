// The part of noVNC's RFB client (`@novnc/novnc`, plain JavaScript without typings)
// that VncView.svelte uses. See its docs/API.md.
declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { credentials?: RfbCredentials; shared?: boolean });
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power: boolean };
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
