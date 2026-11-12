// Council presentation adapter for Munder's post-onboarding god bootstrap.
// The main-process hire path owns provisioning, resume and inbox delivery.
import { useEffect } from 'react';
import { useDispatch } from '@/data/store';
import type { FloorSetup } from '@/data/types';

export function useOrchestratorStartup(setup: FloorSetup | undefined): void {
  const dispatch = useDispatch();
  useEffect(() => {
    if (!setup?.complete || !setup.harnessHome) return;
    // Main deduplicates in-flight attempts and reconciles current PTY ownership.
    // Dispatch surfaces structured errors through FloorProvider's ErrorNotice;
    // Team's explicit start action remains the recovery path.
    void dispatch({ type: 'orchestrator.ensure' });
  }, [setup?.complete, setup?.harnessHome, dispatch]);
}
