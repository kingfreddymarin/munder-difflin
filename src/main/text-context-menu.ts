// NSC-223: native Copy/Paste/Select All on right-click in text and inputs. Electron shows no
// context menu by default. Right-clicks the renderer handles itself (Team rows, agent tree) call
// preventDefault, so Chromium never emits 'context-menu' for them and this menu stays out of the way.
// Clipboard items keep registerAccelerator: false, matching the app Edit menu (dictation paste).

export type TextMenuParams = {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
};

export type TextMenuItem =
  | { role: 'cut' | 'copy' | 'paste' | 'selectAll'; enabled: boolean; registerAccelerator: false }
  | { type: 'separator' };

export function textContextMenuTemplate(p: TextMenuParams): TextMenuItem[] {
  const item = (role: 'cut' | 'copy' | 'paste' | 'selectAll', enabled: boolean): TextMenuItem => ({ role, enabled, registerAccelerator: false });
  const hasSelection = p.selectionText.trim().length > 0;
  if (p.isEditable) {
    return [item('cut', p.editFlags.canCut), item('copy', p.editFlags.canCopy), item('paste', p.editFlags.canPaste),
      { type: 'separator' }, item('selectAll', p.editFlags.canSelectAll)];
  }
  if (hasSelection) return [item('copy', p.editFlags.canCopy), { type: 'separator' }, item('selectAll', p.editFlags.canSelectAll)];
  return [];
}
