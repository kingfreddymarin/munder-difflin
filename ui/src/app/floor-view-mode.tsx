import * as React from 'react';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { findBridge } from '@/data/bridge';

const PREF = 'paramount.floor-views';

interface FloorViewMode {
  enabled: boolean;
  visible: boolean;
  setEnabled(enabled: boolean): void;
  setVisible(visible: boolean): void;
}

const Context = React.createContext<FloorViewMode | null>(null);
export const useFloorViewMode = () => React.useContext(Context);

export function FloorViewProvider({ children }: React.PropsWithChildren) {
  const available = !!findBridge()?.listFloorViews;
  const [enabled, updateEnabled] = React.useState(() => {
    try { return window.localStorage.getItem(PREF) === 'true'; }
    catch { return false; }
  });
  const [visible, setVisible] = React.useState(enabled);
  React.useEffect(() => findBridge()?.onFloorViewControls?.(() => setVisible(false)), []);
  const setEnabled = (value: boolean) => {
    updateEnabled(value);
    setVisible(value);
    try { window.localStorage.setItem(PREF, String(value)); } catch { /* preference remains available for this window */ }
  };
  return <Context.Provider value={available ? { enabled, visible, setEnabled, setVisible } : null}>{children}</Context.Provider>;
}

export function FloorViewToggle({ mode }: { mode: FloorViewMode }) {
  return <label className="flex items-center gap-3 text-sm">
    <Switch aria-label="Show floors in one window" checked={mode.enabled} onCheckedChange={mode.setEnabled} />
    Show floors in one window
  </label>;
}

export function FloorViewSettings() {
  const mode = useFloorViewMode();
  return mode && <FloorViewToggle mode={mode} />;
}
